/**
 * Records end-to-end: install pack → create record (field coercion) → move →
 * activity → links → migrate-legacy (idempotent) → export records CSV.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { api, call, cleanupDataIds, createTestOrg, describeDb, eventsFor, expectEvent, parseJson, req, setScope, sql, waitForRows, type TestOrg } from "./setup";

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));

interface RecordType { id: string; slug: string; stages: Array<{ key: string }>; fields: Array<{ key: string; type: string }> }
interface RecordItem { id: string; type_id: string; title: string; stage: string; data: Record<string, unknown>; contact_id: string | null }

describeDb("records flow", () => {
  let org: TestOrg;
  let patients: RecordType;
  let appointments: RecordType;
  let record: RecordItem;
  let contactId: string;

  beforeAll(async () => {
    org = await createTestOrg("records");
    setScope(org);
  });
  afterAll(async () => {
    await cleanupDataIds([org.dataId]);
  });

  it("installs the healthcare pack (idempotent) and lists its types", async () => {
    const packs = await import("@/app/api/records/packs/route");
    const list = await api<{ packs: Array<{ slug: string; installed?: boolean }> }>(packs.GET, "/api/records/packs", { expect: 200 });
    expect(list.body.packs.map((p) => p.slug)).toContain("healthcare");
    const r = await api<{ types: RecordType[] }>(packs.POST, "/api/records/packs", { json: { slug: "healthcare" }, expect: 201 });
    expect(r.body.types.map((t) => t.slug).sort()).toEqual(["appointments", "patients"]);
    patients = r.body.types.find((t) => t.slug === "patients") as RecordType;
    appointments = r.body.types.find((t) => t.slug === "appointments") as RecordType;
    const again = await api<{ types: RecordType[] }>(packs.POST, "/api/records/packs", { json: { slug: "healthcare" }, expect: 201 });
    expect(again.body.types.map((t) => t.id).sort()).toEqual(r.body.types.map((t) => t.id).sort());
    expect(await sql(`SELECT id FROM record_types WHERE user_id = $1`, [org.dataId])).toHaveLength(2);
    await api(packs.POST, "/api/records/packs", { json: { slug: "not-a-pack" }, expect: 404 });

    const types = await import("@/app/api/records/types/route");
    const t = await api<{ types: RecordType[] }>(types.GET, "/api/records/types", { expect: 200 });
    expect(t.body.types).toHaveLength(2);
    // reserved slug is rejected
    await api(types.POST, "/api/records/types", { json: { name: "Packs", slug: "packs", fields: [], stages: [{ key: "a", label: "A" }] }, expect: 400 });
  });

  it("creates a record with coerced fields, resolves default stage, emits record.created", async () => {
    const contacts = await import("@/app/api/crm/contacts/route");
    contactId = (await api<{ contact: { id: string } }>(contacts.POST, "/api/crm/contacts", { json: { full_name: "Pat Patient", email: "pat@example.test" }, expect: 201 })).body.contact.id;

    const records = await import("@/app/api/records/[type]/route");
    const r = await api<{ record: RecordItem }>(records.POST, `/api/records/patients`, {
      json: {
        title: "Pat Patient",
        data: {
          dob: "1990-02-03",
          contact_email: "  PAT@example.test ",
          contact_phone: "+1 555 0100",
          chief_complaint: "Headache",
          hipaa_consent: "yes",
          unknown_field: "dropped",
        },
      },
      params: { type: "patients" },
      expect: 201,
    });
    record = r.body.record;
    expect(record.stage).toBe("intake");
    expect(record.data.dob).toBe(new Date("1990-02-03").toISOString());
    expect(record.data.hipaa_consent).toBe(true);
    expect(record.data.contact_email).toBe("pat@example.test");
    expect(record.data).not.toHaveProperty("unknown_field");
    await expectEvent(org.dataId, "record.created", record.id);

    // required field missing → 400 with field detail
    const bad = await api<{ error: string; detail?: unknown }>(records.POST, `/api/records/patients`, { json: { title: "No complaint", data: { dob: "not-a-date" } }, params: { type: "patients" }, expect: 400 });
    expect(JSON.stringify(bad.body)).toMatch(/chief_complaint|date/i);
    // unknown type → 404
    await api(records.GET, `/api/records/nope`, { params: { type: "nope" }, expect: 404 });

    const list = await api<{ records: RecordItem[]; counts: Record<string, number> }>(records.GET, `/api/records/patients`, { params: { type: "patients" }, expect: 200 });
    expect(list.body.records.map((x) => x.id)).toContain(record.id);
    expect(list.body.counts.intake).toBe(1);
  });

  it("moves the record (event + activity) and rejects an unknown stage", async () => {
    const move = await import("@/app/api/records/[type]/[id]/move/route");
    const r = await api<{ record: RecordItem }>(move.POST, `/api/records/patients/${record.id}/move`, { json: { stage: "active" }, params: { type: "patients", id: record.id }, expect: 200 });
    expect(r.body.record.stage).toBe("active");
    const ev = await expectEvent(org.dataId, "record.moved", record.id);
    const data = parseJson<{ from: string; to: string }>(ev.data);
    expect(data?.from).toBe("intake");
    expect(data?.to).toBe("active");
    await api(move.POST, `/api/records/patients/${record.id}/move`, { json: { stage: "bogus" }, params: { type: "patients", id: record.id }, expect: 400 });
    await api(move.POST, `/api/records/patients/${randomUUID()}/move`, { json: { stage: "active" }, params: { type: "patients", id: randomUUID() }, expect: 404 });
    // PATCH ignores stage (must go through /move) but updates the title.
    const one = await import("@/app/api/records/[type]/[id]/route");
    const p = await api<{ record: RecordItem }>(one.PATCH, `/api/records/patients/${record.id}`, { method: "PATCH", json: { title: "Pat P.", stage: "discharged" }, params: { type: "patients", id: record.id }, expect: 200 });
    expect(p.body.record.title).toBe("Pat P.");
    expect(p.body.record.stage).toBe("active");
  });

  it("activity timeline: created, moved and a comment", async () => {
    const act = await import("@/app/api/records/[type]/[id]/activity/route");
    const c = await api<{ activity: { kind: string; body: string } }>(act.POST, `/api/records/patients/${record.id}/activity`, { json: { body: "Called the patient" }, params: { type: "patients", id: record.id }, expect: 201 });
    expect(c.body.activity.kind).toBe("comment");
    const g = await api<{ activity: Array<{ kind: string; body: string | null }> }>(act.GET, `/api/records/patients/${record.id}/activity`, { params: { type: "patients", id: record.id }, expect: 200 });
    const kinds = g.body.activity.map((a) => a.kind).sort();
    expect(kinds).toEqual(expect.arrayContaining(["created", "comment"]));
    expect(kinds.some((k) => /move|stage/.test(k))).toBe(true);
    expect(await sql(`SELECT id FROM record_activity WHERE user_id = $1 AND record_id = $2`, [org.dataId, record.id])).toHaveLength(g.body.activity.length);
    await api(act.POST, `/api/records/patients/${record.id}/activity`, { json: { body: "" }, params: { type: "patients", id: record.id }, expect: 400 });
  });

  it("links to a contact and another record; rejects a missing target record", async () => {
    const records = await import("@/app/api/records/[type]/route");
    const appt = (await api<{ record: RecordItem }>(records.POST, `/api/records/appointments`, {
      json: { title: "Follow-up visit", data: { scheduled_at: "2030-01-01T10:00:00Z", visit_type: "Telehealth" } }, params: { type: "appointments" }, expect: 201,
    })).body.record;
    expect(appt.type_id).toBe(appointments.id);

    const links = await import("@/app/api/records/[type]/[id]/links/route");
    const l1 = await api<{ link: { target_kind: string; target_id: string } }>(links.POST, `/api/records/patients/${record.id}/links`, { json: { target_kind: "contact", target_id: contactId }, params: { type: "patients", id: record.id }, expect: 201 });
    expect(l1.body.link.target_kind).toBe("contact");
    await api(links.POST, `/api/records/patients/${record.id}/links`, { json: { target_kind: "record", target_id: appt.id }, params: { type: "patients", id: record.id }, expect: 201 });
    await api(links.POST, `/api/records/patients/${record.id}/links`, { json: { target_kind: "record", target_id: randomUUID() }, params: { type: "patients", id: record.id }, expect: 404 });
    await api(links.POST, `/api/records/patients/${record.id}/links`, { json: { target_kind: "spaceship", target_id: "x" }, params: { type: "patients", id: record.id }, expect: 400 });
    const g = await api<{ links: Array<{ target_kind: string; target_id: string }> }>(links.GET, `/api/records/patients/${record.id}/links`, { params: { type: "patients", id: record.id }, expect: 200 });
    expect(g.body.links.map((l) => `${l.target_kind}:${l.target_id}`).sort()).toEqual([`contact:${contactId}`, `record:${appt.id}`].sort());
    expect(await sql(`SELECT id FROM record_links WHERE user_id = $1 AND record_id = $2`, [org.dataId, record.id])).toHaveLength(2);

    const one = await import("@/app/api/records/[type]/[id]/route");
    const d = await api<{ record: RecordItem; activity: unknown[]; links: unknown[] }>(one.GET, `/api/records/patients/${record.id}`, { params: { type: "patients", id: record.id }, expect: 200 });
    expect(d.body.links).toHaveLength(2);
    // wrong type for this id → 404
    await api(one.GET, `/api/records/appointments/${record.id}`, { params: { type: "appointments", id: record.id }, expect: 404 });
  });

  it("migrate-legacy copies legacy rows once and is idempotent", async () => {
    for (const n of [1, 2]) {
      await sql(
        `INSERT INTO healthcare_patients (id, user_id, full_name, dob, contact_email, contact_phone, chief_complaint, hipaa_consent, created_at)
         VALUES ($1, $2, $3, '1980-01-0${n}', $4, NULL, 'Legacy complaint ${n}', TRUE, NOW())`,
        [randomUUID(), org.dataId, `Legacy Patient ${n}`, `legacy${n}@example.test`]
      );
    }
    const mig = await import("@/app/api/records/migrate-legacy/route");
    const first = await api<{ created: number; skipped: number; results: Array<{ table: string; created: number; skipped: number; errors: string[] }> }>(mig.POST, "/api/records/migrate-legacy", {
      json: { tables: ["healthcare_patients"] }, expect: 200,
    });
    expect(first.body.created).toBe(2);
    expect(first.body.skipped).toBe(0);
    expect(first.body.results.find((r) => r.table === "healthcare_patients")?.errors).toEqual([]);
    const migrated = await sql<{ data: string; title: string }>(`SELECT data, title FROM records WHERE user_id = $1 AND type_id = $2 AND data LIKE '%_legacy_id%'`, [org.dataId, patients.id]);
    expect(migrated).toHaveLength(2);
    expect(migrated.map((m) => parseJson<{ _legacy_id: string }>(m.data)?._legacy_id ?? "")).toEqual(expect.arrayContaining([expect.stringMatching(/^healthcare_patients:/)]));

    const second = await api<{ created: number; skipped: number }>(mig.POST, "/api/records/migrate-legacy", { json: { tables: ["healthcare_patients"] }, expect: 200 });
    expect(second.body.created).toBe(0);
    expect(second.body.skipped).toBe(2);
    expect(await sql(`SELECT id FROM records WHERE user_id = $1 AND type_id = $2`, [org.dataId, patients.id])).toHaveLength(3);
    // silent migration must not spam record.created events
    expect((await eventsFor(org.dataId, "record.created")).length).toBe(2);
  });

  it("exports records as CSV (with type filter) and JSON, and writes an audit row", async () => {
    const exp = await import("@/app/api/export/[entity]/route");
    const csv = await call(exp.GET, req(`/api/export/records`, { query: { format: "csv", type: "patients" } }), { entity: "records" }, 200);
    expect(csv.res.headers.get("content-type")).toContain("text/csv");
    expect(csv.res.headers.get("content-disposition")).toContain("attachment");
    expect(Number(csv.res.headers.get("x-row-count"))).toBe(3);
    const lines = csv.text.trim().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("title");
    expect(csv.text).toContain("Legacy Patient 1");
    expect(csv.text).not.toContain("Follow-up visit");

    const all = await call(exp.GET, req(`/api/export/records`, { query: { format: "json" } }), { entity: "records" }, 200);
    expect(all.res.headers.get("content-type")).toContain("application/json");
    const envelope = JSON.parse(all.text) as { entity: string; count: number; rows: Array<{ id: string; data: unknown }> };
    expect(envelope.entity).toBe("records");
    expect(envelope.count).toBe(4);
    expect(envelope.rows).toHaveLength(4);
    expect(typeof envelope.rows[0].data).toBe("object");
    await api(exp.GET, `/api/export/records`, { query: { format: "xml" }, params: { entity: "records" }, expect: 400 });
    await api(exp.GET, `/api/export/nothing`, { params: { entity: "nothing" }, expect: 404 });

    const [audit] = await waitForRows<{ action: string; diff: string }>(`SELECT action, diff FROM audit_log WHERE user_id = $1 AND entity = 'records' ORDER BY created_at DESC LIMIT 1`, [org.dataId]);
    expect(audit?.action).toBe("export");

    // viewer can export (read) but cannot create records
    setScope(org, { role: "viewer", userId: "itest-viewer" });
    await call(exp.GET, req(`/api/export/records`), { entity: "records" }, 200);
    const records = await import("@/app/api/records/[type]/route");
    await api(records.POST, `/api/records/patients`, { json: { title: "x", data: { chief_complaint: "y" } }, params: { type: "patients" }, expect: 403 });
    setScope(org);
  });
});
