/**
 * Import/export end-to-end: CSV preview + mapping → dry run → import →
 * dedupe on re-import → export contacts (csv/json) → spreadsheet formula guard.
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { api, call, cleanupDataIds, createTestOrg, describeDb, req, setScope, sql, sqlOne, waitForRows, type TestOrg } from "./setup";

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));

interface Preview {
  target: { key: string; fields: Array<{ key: string }>; dedupeKey: string[] };
  headers: string[];
  delimiter: string;
  rowCount: number;
  sample: string[][];
  suggestion: { mapping: Record<string, string | null>; confidence: Record<string, number> };
}
interface ImportResult { inserted: number; skipped: number; errors: Array<{ row: number; field?: string; message: string }>; rowCount: number; dryRun: boolean; jobId: string | null }

const CSV = [
  "Name,E-mail,Phone number,Company,Stage,Deal value,Tags,Notes",
  'Alice Importer,alice@import.test,+1 555 0100,Alpha LLC,customer,"$1,250.50","vip, newsletter",Met at expo',
  "Bob Builder,BOB@import.test,,Beta Inc,lead,300,,=HYPERLINK(\"http://evil.test\")",
  "Carol Dup,alice@import.test,,Alpha LLC,lead,0,,duplicate email of Alice",
  "No Email,,+1 555 0199,Gamma,prospect,,,no address at all",
  ",missing@import.test,,,lead,,,name is required",
].join("\n");

describeDb("import/export flow", () => {
  let org: TestOrg;
  let mapping: Record<string, string | null>;

  beforeAll(async () => {
    org = await createTestOrg("import");
    setScope(org);
  });
  afterAll(async () => {
    await cleanupDataIds([org.dataId]);
  });

  it("preview parses the CSV and suggests a mapping by header synonyms", async () => {
    const preview = await import("@/app/api/import/preview/route");
    const targets = await api<{ targets: Array<{ key: string }>; maxRows: number }>(preview.GET, "/api/import/preview", { expect: 200 });
    expect(targets.body.targets.map((t) => t.key)).toContain("crm_contacts");
    const r = await api<Preview>(preview.POST, "/api/import/preview", { json: { csv: CSV, target: "crm_contacts", ai: false }, expect: 200 });
    expect(r.body.headers).toEqual(["Name", "E-mail", "Phone number", "Company", "Stage", "Deal value", "Tags", "Notes"]);
    expect(r.body.delimiter).toBe(",");
    expect(r.body.rowCount).toBe(5);
    expect(r.body.sample).toHaveLength(5);
    expect(r.body.target.dedupeKey).toEqual(["email"]);
    mapping = r.body.suggestion.mapping;
    expect(mapping).toMatchObject({ full_name: "Name", email: "E-mail", phone: "Phone number", company: "Company", lifecycle: "Stage", deal_value: "Deal value", tags: "Tags", notes: "Notes" });
    expect(r.body.suggestion.confidence.email).toBeGreaterThan(0.5);
    await api(preview.POST, "/api/import/preview", { json: { csv: "\n\n", target: "crm_contacts", ai: false }, expect: 400 });
    await api(preview.POST, "/api/import/preview", { json: { csv: CSV, target: "spaceships" }, expect: 400 });
  });

  it("dry run validates and coerces without writing, reporting per-row errors", async () => {
    const run = await import("@/app/api/import/run/route");
    const r = await api<ImportResult>(run.POST, "/api/import/run", { json: { csv: CSV, target: "crm_contacts", mapping, dryRun: true, fileName: "contacts.csv" }, expect: 200 });
    expect(r.body.dryRun).toBe(true);
    expect(r.body.rowCount).toBe(5);
    // Alice, Bob, No Email insertable; Carol is an in-file duplicate email and the nameless row fails validation (both skipped).
    expect(r.body.inserted).toBe(3);
    expect(r.body.skipped).toBe(2);
    expect(r.body.errors.some((e) => e.row === 5 && e.field === "full_name")).toBe(true);
    expect(await sql(`SELECT id FROM crm_contacts WHERE user_id = $1`, [org.dataId])).toHaveLength(0);
    const job = await sqlOne<{ status: string; dry_run: boolean; inserted: number; file_name: string | null }>(`SELECT * FROM import_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [org.dataId]);
    expect(job?.dry_run ?? true).toBe(true);
  });

  it("import writes coerced rows; re-import dedupes on email; audit + job rows exist", async () => {
    const run = await import("@/app/api/import/run/route");
    const r = await api<ImportResult>(run.POST, "/api/import/run", { json: { csv: CSV, target: "crm_contacts", mapping, fileName: "contacts.csv" }, expect: 200 });
    expect(r.body).toMatchObject({ dryRun: false, inserted: 3, skipped: 2 });
    expect(r.body.jobId).toBeTruthy();
    const rows = await sql<{ full_name: string; email: string | null; phone: string | null; lifecycle: string; deal_value: string | number; tags: string; notes: string | null; company: string | null }>(
      `SELECT full_name, email, phone, lifecycle, deal_value, tags, notes, company FROM crm_contacts WHERE user_id = $1 ORDER BY full_name ASC`, [org.dataId]
    );
    expect(rows.map((c) => c.full_name)).toEqual(["Alice Importer", "Bob Builder", "No Email"]);
    const alice = rows[0];
    expect(alice.email).toBe("alice@import.test");
    expect(alice.lifecycle).toBe("customer");
    expect(Number(alice.deal_value)).toBeGreaterThan(0); // "$1,250.50" parsed as money
    expect(JSON.parse(alice.tags)).toEqual(["vip", "newsletter"]);
    expect(rows[1].email).toBe("bob@import.test"); // lower-cased
    expect(rows[1].notes).toContain("HYPERLINK"); // stored verbatim; neutralised on export
    expect(rows[2].email).toBeNull();

    // Re-import: everyone with an email already exists → skipped; the email-less row has no dedupe key and is inserted again.
    const again = await api<ImportResult>(run.POST, "/api/import/run", { json: { csv: CSV, target: "crm_contacts", mapping }, expect: 200 });
    expect(again.body.inserted).toBe(1);
    expect(again.body.skipped).toBe(4);
    expect(await sql(`SELECT id FROM crm_contacts WHERE user_id = $1`, [org.dataId])).toHaveLength(4);
    expect(await sql(`SELECT id FROM crm_contacts WHERE user_id = $1 AND LOWER(email) = 'alice@import.test'`, [org.dataId])).toHaveLength(1);

    const jobs = await import("@/app/api/import/jobs/route");
    const j = await api<{ jobs: Array<{ id: string; target: string; inserted: number; skipped: number; dry_run?: boolean }> }>(jobs.GET, "/api/import/jobs", { expect: 200 });
    expect(j.body.jobs.length).toBeGreaterThanOrEqual(3);
    expect(j.body.jobs.map((x) => x.id)).toContain(r.body.jobId);
    const audit = await waitForRows<{ action: string; entity: string; entity_id: string }>(`SELECT action, entity, entity_id FROM audit_log WHERE user_id = $1 AND action = 'import'`, [org.dataId], 2);
    expect(audit.map((a) => a.entity_id)).toContain(r.body.jobId);
    expect(audit.every((a) => a.entity === "crm_contacts")).toBe(true);
  });

  it("exports contacts as CSV and JSON; formula-looking cells are neutralised", async () => {
    const exp = await import("@/app/api/export/[entity]/route");
    const csv = await call(exp.GET, req(`/api/export/contacts`, { query: { format: "csv" } }), { entity: "contacts" }, 200);
    expect(csv.res.headers.get("content-type")).toContain("text/csv");
    expect(csv.res.headers.get("content-disposition")).toMatch(/attachment; filename="contacts.*\.csv"/);
    expect(Number(csv.res.headers.get("x-row-count"))).toBe(4);
    const lines = csv.text.replace(/^﻿/, "").trim().split(/\r?\n/);
    expect(lines).toHaveLength(5);
    expect(lines[0].split(",")).toEqual(expect.arrayContaining(["id", "full_name", "email", "tags", "notes"]));
    expect(csv.text).toContain("'=HYPERLINK");
    expect(csv.text).not.toMatch(/(^|,)=HYPERLINK/m);
    // tags are emitted as JSON inside a quoted cell
    expect(csv.text).toContain('"[""vip"",""newsletter""]"');

    const json = await call(exp.GET, req(`/api/export/contacts`, { query: { format: "json" } }), { entity: "contacts" }, 200);
    const envelope = JSON.parse(json.text) as { entity: string; count: number; rows: Array<{ full_name: string; tags: unknown; notes: string | null }> };
    expect(envelope.count).toBe(4);
    expect(envelope.rows.find((r) => r.full_name === "Alice Importer")?.tags).toEqual(["vip", "newsletter"]);
    expect(envelope.rows.find((r) => r.full_name === "Bob Builder")?.notes).toBe('=HYPERLINK("http://evil.test")'); // JSON is not a spreadsheet; raw value kept

    // Date window filter
    const none = await call(exp.GET, req(`/api/export/contacts`, { query: { format: "csv", to: "2000-01-01" } }), { entity: "contacts" }, 200);
    expect(Number(none.res.headers.get("x-row-count"))).toBe(0);
    // Pure helper: every dangerous prefix is escaped
    const { csvCell } = await import("@/lib/export/csv");
    for (const v of ["=1+1", "+1", "-1", "@cmd", "\tx"]) expect(csvCell(v).startsWith("'")).toBe(true);
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('a"b,c')).toBe('"a""b,c"');
  });

  it("viewer cannot import; import permission follows the target area", async () => {
    setScope(org, { role: "viewer", userId: "itest-viewer" });
    const run = await import("@/app/api/import/run/route");
    await api(run.POST, "/api/import/run", { json: { csv: CSV, target: "crm_contacts", mapping, dryRun: true }, expect: 403 });
    const preview = await import("@/app/api/import/preview/route");
    await api(preview.POST, "/api/import/preview", { json: { csv: CSV, target: "crm_contacts", ai: false }, expect: 403 });
    // member may edit crm → allowed even though they cannot see settings
    setScope(org, { role: "member", userId: "itest-member" });
    await api(run.POST, "/api/import/run", { json: { csv: CSV, target: "crm_contacts", mapping, dryRun: true }, expect: 200 });
    await api(preview.GET, "/api/import/preview", { expect: 403 });
    setScope(org);
  });
});
