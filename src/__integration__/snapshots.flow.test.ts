/**
 * Phase 9 lane D: workspace snapshots + full tenant export.
 *
 * Seed configuration (settings, record types, tax rate, SLA, templates, KB,
 * automation with secrets) and data (contact, ticket) → snapshot → create a
 * child org from it (config present, data absent) → re-apply is idempotent →
 * merge vs skip_existing → foreign JSON with a secret rejected → full NDJSON
 * export (manifest + sha256, no denylisted columns) → viewer 403 → API v1.
 */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { api, call, cleanupDataIds, createTestOrg, describeDb, req, setScope, sql, sqlOne, type TestOrg } from "./setup";

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));

interface Meta { id: string; name: string; sections: string[]; sha256: string; visibility: string }
interface SnapshotResult { snapshot_id: string; status: string; created: number; updated: number; skipped: number; errors: unknown[] }
interface Plan { totals: { create: number; update: number; skip: number; conflicts: number }; sections: Array<{ section: string; create: number; update: number; skip: number; conflicts: string[] }> }
interface Applied { result: { status: string; created: number; updated: number; skipped: number; errors: unknown[]; plan: Plan } }

describeDb("snapshots flow", () => {
  let org: TestOrg;
  let other: TestOrg;
  let childOrg: TestOrg;
  let snap: Meta;
  const extra: string[] = [];

  beforeAll(async () => {
    org = await createTestOrg("snap-src");
    other = await createTestOrg("snap-other");
    setScope(org);
    const { updateOrgSettings } = await import("@/lib/org-settings");
    const { updateBranding } = await import("@/lib/branding");
    const { createType } = await import("@/lib/records/store");
    const { createTaxRate } = await import("@/lib/money/tax-rates");
    const { createPolicy } = await import("@/lib/helpdesk/tickets");
    const { createAutomation } = await import("@/lib/automations/store");
    const { createTemplate } = await import("@/lib/marketing/templates");
    const { createArticle } = await import("@/lib/kb/articles");
    const { createContact } = await import("@/lib/crm/contacts");
    const { createTicket } = await import("@/lib/helpdesk/tickets");
    await updateOrgSettings(org.dataId, { currency: "EUR", timezone: "Europe/Berlin" });
    await updateBranding(org.dataId, { brand_name: "Source Studio", primary_color: "#112233", logo_url: "http://insecure.example/logo.png" });
    await createType(org.dataId, { slug: "projects-x", name: "Projects X", icon: "box", description: null, fields: [{ key: "client", label: "Client", type: "text" }], stages: [{ key: "new", label: "New" }], views: {}, copilot_prompt: null } as Parameters<typeof createType>[1]);
    await createTaxRate(org.dataId, { name: "VAT", rate_bp: 2000, kind: "vat", is_default: true });
    await createPolicy(org.dataId, { name: "Standard SLA", first_response_minutes: 30, resolution_minutes: 480 });
    await createTemplate(org.dataId, { name: "Welcome", subject: "Hi {{name}}", body_md: "Welcome aboard", category: "general" });
    await createArticle(org.dataId, { title: "How to reset", body_md: "Steps", status: "published" });
    await createArticle(org.dataId, { title: "Draft only", body_md: "wip", status: "draft" });
    await createAutomation(org.dataId, {
      name: "Slack ping", description: null, trigger_type: "event", trigger_config: { event_type: "crm.contact.created" }, conditions: null, autonomy: "auto", enabled: true,
      steps: [
        { id: "s1", kind: "webhook", config: { url: "https://hooks.slack.com/services/T0/B0/abcdefghijk", secret: "supersecretvalue" } },
        { id: "s2", kind: "notify", config: { channel: "email", to: "boss@example.com", body: "New {{contact.name}}" } },
      ],
    } as unknown as Parameters<typeof createAutomation>[1]);
    // DATA that must never travel
    await createContact(org.dataId, { full_name: "Private Person", email: "private.person@example.test" } as Parameters<typeof createContact>[1]);
    await createTicket(org.dataId, { subject: "Secret ticket", requester_email: "r@example.test", body: "hello" } as Parameters<typeof createTicket>[1]).catch(() => undefined);
  });
  afterAll(async () => {
    await cleanupDataIds([org.dataId, other.dataId, ...extra]);
  });

  it("creates a snapshot of configuration only, with no secrets, ids or data", async () => {
    const r = await import("@/app/api/snapshots/route");
    await api(r.POST, "/api/snapshots", { json: { name: "" }, expect: 400 });
    await api(r.POST, "/api/snapshots", { json: { name: "x", sections: ["contacts"] }, expect: 400 });
    const created = await api<{ snapshot: Meta }>(r.POST, "/api/snapshots", { json: { name: "Agency starter", visibility: "agency" }, expect: 201 });
    snap = created.body.snapshot;
    expect(snap.sections).toEqual(expect.arrayContaining(["settings", "branding", "record_types", "tax_rates", "sla_policies", "automations", "email_templates", "kb_articles"]));

    const one = await import("@/app/api/snapshots/[id]/route");
    const dl = await call<string>(one.GET, req(`/api/snapshots/${snap.id}`, { query: { download: "1" } }), { id: snap.id }, 200);
    expect(dl.res.headers.get("content-disposition")).toContain("attachment");
    expect(createHash("sha256").update(dl.text).digest("hex")).toBe(snap.sha256);
    const doc = JSON.parse(dl.text) as { schema: number; sections: Record<string, unknown> };
    expect(doc.schema).toBe(1);
    for (const needle of ["Private Person", "private.person", "Secret ticket", "hooks.slack.com", "supersecretvalue", "boss@example.com", org.dataId, org.orgId]) expect(dl.text).not.toContain(needle);
    const branding = doc.sections.branding as { brand_name: string; logo_url: string | null };
    expect(branding.brand_name).toBe("Source Studio");
    expect(branding.logo_url).toBeNull(); // http logo does not travel
    const kb = doc.sections.kb_articles as Array<{ title: string }>;
    expect(kb.map((a) => a.title)).toEqual(["How to reset"]);

    const list = await api<{ snapshots: Meta[]; counts: Record<string, number> }>(r.GET, "/api/snapshots", { query: { counts: "1" }, expect: 200 });
    expect(list.body.snapshots.map((s) => s.id)).toContain(snap.id);
    expect(list.body.counts.tax_rates).toBe(1);
  });

  it("creating a client workspace from the snapshot copies configuration, not data", async () => {
    const ws = await import("@/app/api/agency/workspaces/route");
    const r = await api<{ client: { id: string; dataId: string; name: string; slug: string }; snapshot_result: SnapshotResult }>(ws.POST, "/api/agency/workspaces", {
      json: { name: "Snap Client", snapshot_id: snap.id }, expect: 201,
    });
    const c = r.body.client;
    extra.push(c.dataId);
    childOrg = { dataId: c.dataId, orgId: c.id, userId: org.userId, email: org.email, slug: c.slug, name: c.name };
    expect(r.body.snapshot_result.errors).toEqual([]);
    expect(r.body.snapshot_result.status).toBe("applied");
    expect(r.body.snapshot_result.created).toBeGreaterThanOrEqual(7);

    expect((await sqlOne<{ n: string }>(`SELECT COUNT(*)::text AS n FROM record_types WHERE user_id = $1 AND slug = 'projects-x'`, [c.dataId]))?.n).toBe("1");
    expect((await sqlOne<{ rate_bp: number }>(`SELECT rate_bp FROM tax_rates WHERE user_id = $1 AND name = 'VAT'`, [c.dataId]))?.rate_bp).toBe(2000);
    expect((await sqlOne<{ n: string }>(`SELECT COUNT(*)::text AS n FROM sla_policies WHERE user_id = $1`, [c.dataId]))?.n).toBe("1");
    expect((await sqlOne<{ n: string }>(`SELECT COUNT(*)::text AS n FROM kb_articles WHERE user_id = $1`, [c.dataId]))?.n).toBe("1");
    const org2 = await sqlOne<{ settings: string }>(`SELECT settings FROM organizations WHERE owner_user_id = $1`, [c.dataId]);
    expect(JSON.parse(org2?.settings ?? "{}")).toMatchObject({ currency: "EUR", timezone: "Europe/Berlin" });
    const auto = await sqlOne<{ status: string; enabled: boolean; autonomy: string }>(`SELECT status, enabled, autonomy FROM automations WHERE user_id = $1 AND name = 'Slack ping'`, [c.dataId]);
    expect(auto).toMatchObject({ enabled: false, autonomy: "approve" });
    // data never travels
    for (const t of ["crm_contacts", "tickets", "invoices", "bookings"]) {
      expect((await sqlOne<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${t} WHERE user_id = $1`, [c.dataId]))?.n, t).toBe("0");
    }
    // registry rows
    expect((await sqlOne<{ n: string }>(`SELECT COUNT(*)::text AS n FROM snapshot_objects WHERE user_id = $1`, [c.dataId]))?.n).not.toBe("0");
    expect((await sqlOne<{ n: string }>(`SELECT COUNT(*)::text AS n FROM snapshot_applications WHERE user_id = $1`, [c.dataId]))?.n).toBe("1");
    const ev = await sqlOne<{ type: string }>(`SELECT type FROM events WHERE user_id = $1 AND type = 'snapshot.applied'`, [c.dataId]);
    expect(ev?.type).toBe("snapshot.applied");
  });

  it("a snapshot id that is not shared fails softly: the org is still created", async () => {
    setScope(org);
    const ws = await import("@/app/api/agency/workspaces/route");
    const r = await api<{ client: { dataId: string }; snapshot_result: SnapshotResult }>(ws.POST, "/api/agency/workspaces", { json: { name: "Soft Fail", snapshot_id: randomUUID() }, expect: 201 });
    extra.push(r.body.client.dataId);
    expect(r.body.snapshot_result.status).toBe("failed");
    expect(r.body.snapshot_result.errors.length).toBe(1);
  });

  it("re-applying is idempotent: plan then apply twice → nothing created or updated", async () => {
    setScope(childOrg);
    const plan = await import("@/app/api/snapshots/[id]/plan/route");
    const apply = await import("@/app/api/snapshots/[id]/apply/route");
    const p = await api<{ plan: Plan }>(plan.POST, `/api/snapshots/${snap.id}/plan`, { json: { target: "self", mode: "merge" }, params: { id: snap.id }, expect: 200 });
    expect(p.body.plan.totals.create).toBe(0);
    expect(p.body.plan.totals.update).toBe(0);
    expect(p.body.plan.totals.skip).toBeGreaterThan(0);
    for (let i = 0; i < 2; i++) {
      const a = await api<Applied>(apply.POST, `/api/snapshots/${snap.id}/apply`, { json: { mode: "skip_existing" }, params: { id: snap.id }, expect: 200 });
      expect(a.body.result).toMatchObject({ created: 0, updated: 0, status: "applied" });
      expect(a.body.result.skipped).toBeGreaterThan(0);
    }
    expect((await sqlOne<{ n: string }>(`SELECT COUNT(*)::text AS n FROM tax_rates WHERE user_id = $1`, [childOrg.dataId]))?.n).toBe("1");
    expect((await sqlOne<{ n: string }>(`SELECT COUNT(*)::text AS n FROM record_types WHERE user_id = $1`, [childOrg.dataId]))?.n).toBe("1");
  });

  it("merge updates snapshot-owned rows; skip_existing never overwrites; foreign rows are conflicts", async () => {
    // Parent changes the VAT rate and takes a second snapshot.
    setScope(org);
    await sql(`UPDATE tax_rates SET rate_bp = 2100 WHERE user_id = $1 AND name = 'VAT'`, [org.dataId]);
    const r = await import("@/app/api/snapshots/route");
    const v2 = (await api<{ snapshot: Meta }>(r.POST, "/api/snapshots", { json: { name: "v2", sections: ["tax_rates"], visibility: "agency" }, expect: 201 })).body.snapshot;

    setScope(childOrg);
    const apply = await import("@/app/api/snapshots/[id]/apply/route");
    const skip = await api<Applied>(apply.POST, `/api/snapshots/${v2.id}/apply`, { json: { mode: "skip_existing" }, params: { id: v2.id }, expect: 200 });
    expect(skip.body.result).toMatchObject({ created: 0, updated: 0 });
    expect((await sqlOne<{ rate_bp: number }>(`SELECT rate_bp FROM tax_rates WHERE user_id = $1 AND name = 'VAT'`, [childOrg.dataId]))?.rate_bp).toBe(2000);
    const merged = await api<Applied>(apply.POST, `/api/snapshots/${v2.id}/apply`, { json: { mode: "merge" }, params: { id: v2.id }, expect: 200 });
    expect(merged.body.result).toMatchObject({ created: 0, updated: 1 });
    expect((await sqlOne<{ rate_bp: number }>(`SELECT rate_bp FROM tax_rates WHERE user_id = $1 AND name = 'VAT'`, [childOrg.dataId]))?.rate_bp).toBe(2100);
    const again = await api<Applied>(apply.POST, `/api/snapshots/${v2.id}/apply`, { json: { mode: "merge" }, params: { id: v2.id }, expect: 200 });
    expect(again.body.result).toMatchObject({ created: 0, updated: 0 });

    // A workspace that already has its own "VAT" (not snapshot-owned) is never touched, even in merge mode.
    const { createTaxRate } = await import("@/lib/money/tax-rates");
    await createTaxRate(other.dataId, { name: "VAT", rate_bp: 500, kind: "vat" });
    const { getSnapshotDoc, planSnapshot, applySnapshot } = await import("@/lib/snapshots/store");
    setScope(org);
    const found = await getSnapshotDoc(org.dataId, v2.id);
    expect(found).not.toBeNull();
    const plan = await planSnapshot(other.dataId, found!.doc, { mode: "merge" });
    expect(plan.totals).toMatchObject({ create: 0, update: 0, skip: 1, conflicts: 1 });
    expect(plan.sections[0].conflicts).toEqual(["VAT"]);
    const res = await applySnapshot(other.dataId, found!.doc, { mode: "merge" });
    expect(res.updated).toBe(0);
    expect((await sqlOne<{ rate_bp: number }>(`SELECT rate_bp FROM tax_rates WHERE user_id = $1 AND name = 'VAT'`, [other.dataId]))?.rate_bp).toBe(500);
  });

  it("import: a foreign file with a secret-like key is rejected; a clean one is stored", async () => {
    setScope(org);
    const imp = await import("@/app/api/snapshots/import/route");
    const bad = { schema: 1, name: "Foreign", sections: { automations: [{ schema: 2, name: "A", trigger_type: "manual", trigger_config: { api_key: "abc" }, steps: [], autonomy: "approve" }] } };
    const rej = await call<{ error: string }>(imp.POST, req("/api/snapshots/import", { text: JSON.stringify(bad) }), {}, 422);
    expect(rej.body.error).toMatch(/credential/i);
    const unknown = { schema: 1, name: "Foreign", sections: { contacts: [{ name: "x" }] } };
    await call(imp.POST, req("/api/snapshots/import", { text: JSON.stringify(unknown) }), {}, 422);
    await call(imp.POST, req("/api/snapshots/import", { text: "{not json" }), {}, 422);
    const good = { schema: 1, name: "Foreign ok", sections: { tax_rates: [{ name: "GST", rate_bp: 1800, kind: "gst" }] } };
    const ok = await call<{ snapshot: Meta }>(imp.POST, req("/api/snapshots/import", { text: JSON.stringify(good) }), {}, 201);
    expect(ok.body.snapshot.sections).toEqual(["tax_rates"]);
    const one = await import("@/app/api/snapshots/[id]/route");
    await api(one.DELETE, `/api/snapshots/${ok.body.snapshot.id}`, { method: "DELETE", params: { id: ok.body.snapshot.id }, expect: 200 });
    await api(one.GET, `/api/snapshots/${ok.body.snapshot.id}`, { params: { id: ok.body.snapshot.id }, expect: 404 });
  });

  it("full export streams NDJSON with a header, rows, and a manifest whose sha256 matches", async () => {
    setScope(org);
    const exp = await import("@/app/api/workspace/export/route");
    // Seed rows that must be excluded / stripped.
    await sql(`INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, scopes) VALUES ($1, $2, 'k', 'hashvalue', 'kh_', '["read:crm"]')`, [randomUUID(), org.dataId]).catch(() => undefined);
    const out = await call<string>(exp.POST, req("/api/workspace/export", { method: "POST" }), {}, 200);
    expect(out.res.headers.get("content-type")).toContain("application/x-ndjson");
    const lines = out.text.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(5);
    const objs = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(objs[0]).toMatchObject({ type: "header", format: "kernelhub-tenant-export" });
    const manifest = objs[objs.length - 1] as { type: string; sha256: string; counts: Record<string, number>; rows: number; complete: boolean };
    expect(manifest.type).toBe("manifest");
    expect(manifest.complete).toBe(true);
    const body = lines.slice(0, -1).map((l) => `${l}\n`).join("");
    expect(createHash("sha256").update(body).digest("hex")).toBe(manifest.sha256);
    const rows = objs.slice(1, -1) as Array<{ table: string; row: Record<string, unknown> }>;
    expect(rows.length).toBe(manifest.rows);
    expect(manifest.counts.crm_contacts).toBe(1);
    expect(rows.some((r) => r.table === "crm_contacts" && r.row.user_id === org.dataId)).toBe(true);
    // excluded tables and denylisted columns never appear
    expect(rows.some((r) => ["api_keys", "memberships", "share_tokens", "user_integrations"].includes(r.table))).toBe(false);
    const { isDeniedColumn } = await import("@/lib/snapshots/tables");
    for (const r of rows) for (const col of Object.keys(r.row)) expect(isDeniedColumn(col), `${r.table}.${col}`).toBe(false);
    expect(out.text).not.toContain("hashvalue");
    // every row belongs to this workspace
    for (const r of rows) if ("user_id" in r.row) expect(r.row.user_id).toBe(org.dataId);

    // resume cursor: unknown table is reported, a known table restarts from there
    const bad = await call<string>(exp.POST, req("/api/workspace/export", { method: "POST", query: { table: "nope" } }), {}, 200);
    expect(bad.text).toContain("unknown table");
    const resumed = await call<string>(exp.POST, req("/api/workspace/export", { method: "POST", query: { table: "tax_rates" } }), {}, 200);
    const rl = resumed.text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { table?: string; type?: string });
    expect(rl.some((x) => x.table === "tax_rates")).toBe(true);
    expect(rl.some((x) => x.table === "crm_contacts")).toBe(false);
  });

  it("roles: viewer gets 403 on snapshots and export; non-owner admin cannot export everything", async () => {
    const r = await import("@/app/api/snapshots/route");
    const exp = await import("@/app/api/workspace/export/route");
    setScope(org, { role: "viewer", userId: `itest-viewer-${randomUUID()}` });
    await api(r.GET, "/api/snapshots", { expect: 403 });
    await api(r.POST, "/api/snapshots", { json: { name: "x" }, expect: 403 });
    await call(exp.POST, req("/api/workspace/export", { method: "POST" }), {}, 403);
    setScope(org, { role: "admin", userId: `itest-admin-${randomUUID()}` });
    await api(r.GET, "/api/snapshots", { expect: 200 });
    await call(exp.POST, req("/api/workspace/export", { method: "POST" }), {}, 403);
    setScope(org);
  });

  describe("API v1", () => {
    it("lists and gets snapshots with a read:settings key; 403 without the scope", async () => {
      setScope(org);
      const keys = await import("@/app/api/api-keys/route");
      const good = await api<{ key: string }>(keys.POST, "/api/api-keys", { json: { name: "snap read", scopes: ["read:settings"] }, expect: 201 });
      const crmOnly = await api<{ key: string }>(keys.POST, "/api/api-keys", { json: { name: "crm only", scopes: ["read:crm"] }, expect: 201 });
      const list = await import("@/app/api/v1/snapshots/route");
      const one = await import("@/app/api/v1/snapshots/[id]/route");
      const l = await api<{ data: Array<{ id: string; name: string }> }>(list.GET, "/api/v1/snapshots", { headers: { authorization: `Bearer ${good.body.key}` }, expect: 200 });
      expect(l.body.data.map((s) => s.id)).toContain(snap.id);
      const g = await api<{ data: { id: string; sha256: string } }>(one.GET, `/api/v1/snapshots/${snap.id}`, { params: { id: snap.id }, headers: { authorization: `Bearer ${good.body.key}` }, expect: 200 });
      expect(g.body.data.sha256).toBe(snap.sha256);
      await api(list.GET, "/api/v1/snapshots", { headers: { authorization: `Bearer ${crmOnly.body.key}` }, expect: 403 });
    });
  });
});
