/**
 * Phase 8 lane A: review-gap closures.
 * tasks due_at/assignee/priority + overdue tile → attachments office sniffing +
 * streaming cap + purge sweep → marketplace v2 automation listing export/install →
 * automations PATCH keeps secrets behind the redacted placeholder.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { api, call, cleanupDataIds, createTestOrg, describeDb, expectEvent, setScope, sql, sqlOne, type TestOrg } from "./setup";
import type { TaskDTO } from "@/lib/tasks/store";
import type { AttachmentDTO } from "@/lib/attachments/types";
import type { AutomationDTO } from "@/lib/automations/types";

// Local disk storage for attachments (no Supabase in the integration harness).
const localDir = mkdtempSync(join(tmpdir(), "kh-attachments-"));
process.env.ATTACHMENTS_LOCAL_DIR = localDir;

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));

function fakeZip(entries: string[]): Uint8Array<ArrayBuffer> {
  const body = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(entries.join("\0"), "latin1"), Buffer.alloc(64)]);
  const out = new Uint8Array(new ArrayBuffer(body.length));
  out.set(body);
  return out;
}
function bytes(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
}
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describeDb("phase 8 lane A flow", () => {
  let org: TestOrg;
  let contactId: string;
  let task: TaskDTO;

  beforeAll(async () => {
    org = await createTestOrg("p8a");
    setScope(org);
    contactId = randomUUID();
    await sql(`INSERT INTO crm_contacts (id, user_id, full_name, email) VALUES ($1, $2, 'Files Person', 'files@example.test')`, [contactId, org.dataId]);
  });
  afterAll(async () => {
    await cleanupDataIds([org.dataId]);
    rmSync(localDir, { recursive: true, force: true });
  });

  it("tasks carry due_at, assignee_id and priority; overdue is computed and filterable; home tile counts it", async () => {
    const route = await import("@/app/api/tasks/route");
    await api(route.POST, "/api/tasks", { json: { title: "x", priority: "asap" }, expect: 400 });
    const past = new Date(Date.now() - 3_600_000).toISOString();
    const created = await api<{ task: TaskDTO }>(route.POST, "/api/tasks", { json: { title: "Chase the invoice", due_at: past, assignee_id: org.userId, priority: "high" }, expect: 200 });
    task = created.body.task;
    expect(task).toMatchObject({ priority: "high", assignee_id: org.userId, overdue: true });
    expect(new Date(task.due_at ?? 0).toISOString()).toBe(past);
    await expectEvent(org.dataId, "task.created", task.id);
    const later = await api<{ task: TaskDTO }>(route.POST, "/api/tasks", { json: { title: "Later", due_at: new Date(Date.now() + 86_400_000).toISOString() }, expect: 200 });
    expect(later.body.task.overdue).toBe(false);
    expect(later.body.task.priority).toBe("normal");

    const overdue = await api<{ tasks: TaskDTO[] }>(route.GET, "/api/tasks", { query: { overdue: "1" }, expect: 200 });
    expect(overdue.body.tasks.map((t) => t.id)).toEqual([task.id]);
    const mine = await api<{ tasks: TaskDTO[] }>(route.GET, "/api/tasks", { query: { assignee: "me" }, expect: 200 });
    expect(mine.body.tasks.map((t) => t.id)).toEqual([task.id]);

    const { buildHomeSummary } = await import("@/lib/home/summary");
    const summary = await buildHomeSummary({ dataId: org.dataId, userId: org.userId, can: () => true });
    const tile = (summary.kpis ?? []).find((t) => t.key === "tasks");
    expect(tile?.hint).toBe("1 task overdue");
    expect(tile?.href).toBe("/tasks?overdue=1");

    // Completing clears overdue; the column names stay exactly due_at / assignee_id / priority.
    const patched = await api<{ task: TaskDTO }>(route.PATCH, "/api/tasks", { method: "PATCH", json: { id: task.id, done: true, priority: "low", assignee_id: null }, expect: 200 });
    expect(patched.body.task).toMatchObject({ done: true, overdue: false, priority: "low", assignee_id: null });
    const row = await sqlOne<{ due_at: string; assignee_id: string | null; priority: string }>(`SELECT due_at, assignee_id, priority FROM tasks WHERE id::text = $1 AND user_id = $2`, [task.id, org.dataId]);
    expect(row).toMatchObject({ assignee_id: null, priority: "low" });
    expect(row?.due_at).toBeTruthy();
  });

  it("API v1 tasks accept and return the new fields", async () => {
    const keys = await import("@/app/api/api-keys/route");
    const k = await api<{ key: string }>(keys.POST, "/api/api-keys", { json: { name: "p8a", scopes: ["write:tasks"] }, expect: 201 });
    const bearer = { authorization: `Bearer ${k.body.key}` };
    const v1 = await import("@/app/api/v1/tasks/route");
    const due = new Date(Date.now() - 60_000).toISOString();
    const c = await api<{ data: TaskDTO }>(v1.POST, "/api/v1/tasks", { headers: bearer, json: { title: "Via API", due_at: due, priority: "urgent", assignee_id: org.userId }, expect: 201 });
    expect(c.body.data).toMatchObject({ priority: "urgent", assignee_id: org.userId, overdue: true });
    await api(v1.POST, "/api/v1/tasks", { headers: bearer, json: { title: "bad", priority: "whenever" }, expect: 422 });
    const l = await api<{ data: TaskDTO[] }>(v1.GET, "/api/v1/tasks", { headers: bearer, query: { overdue: "true", assignee_id: org.userId }, expect: 200 });
    expect(l.body.data.map((t) => t.id)).toEqual([c.body.data.id]);
  });

  it("attachments: office formats are sniffed (docx ok, xlsx bytes as docx refused); oversize bodies are cut off while streaming", async () => {
    const route = await import("@/app/api/attachments/route");
    const good = new FormData();
    good.set("file", new File([fakeZip(["[Content_Types].xml", "word/document.xml"])], "brief.docx", { type: DOCX }));
    good.set("entity_kind", "contact");
    good.set("entity_id", contactId);
    const up = await call<{ attachment: AttachmentDTO }>(route.POST, new NextRequest(`http://localhost:3001/api/attachments`, { method: "POST", body: good }), {}, 201);
    expect(up.body.attachment.content_type).toBe(DOCX);

    const wrong = new FormData();
    wrong.set("file", new File([fakeZip(["[Content_Types].xml", "xl/workbook.xml"])], "sheet.docx", { type: DOCX }));
    wrong.set("entity_kind", "contact");
    wrong.set("entity_id", contactId);
    const r = await call<{ error: string; detail: string }>(route.POST, new NextRequest(`http://localhost:3001/api/attachments`, { method: "POST", body: wrong }), {}, 415);
    expect(r.body.detail).toMatch(/not a valid DOCX/);

    const ole = new FormData();
    ole.set("file", new File([bytes("not-ole-bytes")], "old.doc", { type: "application/msword" }));
    ole.set("entity_kind", "contact");
    ole.set("entity_id", contactId);
    await call(route.POST, new NextRequest(`http://localhost:3001/api/attachments`, { method: "POST", body: ole }), {}, 415);

    // 21 MB CSV without a content-length header: the stream cap rejects it before buffering the whole body.
    const big = new FormData();
    big.set("file", new File([new Uint8Array(21 * 1024 * 1024).fill(0x61)], "huge.csv", { type: "text/csv" }));
    big.set("entity_kind", "contact");
    big.set("entity_id", contactId);
    const tooBig = await call<{ error: string }>(route.POST, new NextRequest(`http://localhost:3001/api/attachments`, { method: "POST", body: big }), {}, 413);
    expect(tooBig.body.error).toBe("payload_too_large");

    // Purge sweep: soft-deleted 31 days ago → storage object and row removed; a fresh soft delete is kept.
    const one = await import("@/app/api/attachments/[id]/route");
    await api(one.DELETE, `/api/attachments/${up.body.attachment.id}`, { method: "DELETE", params: { id: up.body.attachment.id }, expect: 200 });
    const keep = new FormData();
    keep.set("file", new File([bytes("a,b\n")], "keep.csv", { type: "text/csv" }));
    keep.set("entity_kind", "contact");
    keep.set("entity_id", contactId);
    const kept = await call<{ attachment: AttachmentDTO }>(route.POST, new NextRequest(`http://localhost:3001/api/attachments`, { method: "POST", body: keep }), {}, 201);
    await api(one.DELETE, `/api/attachments/${kept.body.attachment.id}`, { method: "DELETE", params: { id: kept.body.attachment.id }, expect: 200 });
    await sql(`UPDATE attachments SET deleted_at = NOW() - INTERVAL '31 days' WHERE id = $1 AND user_id = $2`, [up.body.attachment.id, org.dataId]);
    const path = await sqlOne<{ storage_path: string }>(`SELECT storage_path FROM attachments WHERE id = $1`, [up.body.attachment.id]);
    const { purgeDeletedAttachments } = await import("@/lib/attachments/store");
    const { getObject } = await import("@/lib/attachments/storage");
    expect(await getObject(path!.storage_path, DOCX)).not.toBeNull();
    const purged = await purgeDeletedAttachments(30);
    expect(purged.purged).toBeGreaterThanOrEqual(1);
    expect(await sqlOne(`SELECT 1 FROM attachments WHERE id = $1`, [up.body.attachment.id])).toBeNull();
    expect(await getObject(path!.storage_path, DOCX)).toBeNull();
    expect(await sqlOne(`SELECT 1 FROM attachments WHERE id = $1`, [kept.body.attachment.id])).toBeTruthy();
  });

  it("marketplace: a v2 automation exports scrubbed (no secrets/ids/URLs) and installs paused as a v2 row; PATCH with the redacted placeholder keeps the real secret", async () => {
    const { createAutomation, definitionOf, REDACTED_SECRET } = await import("@/lib/automations/store");
    const { publishListing } = await import("@/lib/marketplace/catalog");
    const { installListing } = await import("@/lib/marketplace/install");
    const { WEBHOOK_URL_PLACEHOLDER } = await import("@/lib/marketplace/types");
    const src = await createAutomation(org.dataId, {
      name: "Escalate hot tickets",
      description: "Pings ops",
      trigger_type: "webhook",
      trigger_config: { event_type: "ticket.created", webhook: { token: "inbound-token-abcdefgh" } },
      conditions: null,
      autonomy: "auto",
      enabled: true,
      steps: [
        { id: "hook", kind: "webhook", config: { url: "https://hooks.example.com/t/ABC", secret: "signing-secret-1", payload: { text: "{{event.type}}" } } },
        { id: "note", kind: "notify", config: { channel: "email", to: "ops@example.test", subject: "Hot", body: "See {{entity.title}}" } },
      ],
    });
    const published = await publishListing(org.dataId, { kind: "automation", entityId: src.id, visibility: "org" });
    const def = published.listing.definition as { schema: number; trigger_config: Record<string, unknown>; steps: Array<{ id: string; kind: string; config: Record<string, unknown> }> };
    expect(def.schema).toBe(2);
    expect(def.trigger_config.webhook).toBeUndefined();
    const json = JSON.stringify(def);
    for (const secret of ["inbound-token-abcdefgh", "hooks.example.com", "signing-secret-1", "ops@example.test"]) expect(json).not.toContain(secret);
    expect(def.steps[0].config.url).toBe(WEBHOOK_URL_PLACEHOLDER);
    expect(published.scrubbed.sort()).toEqual(["steps.hook.secret", "steps.hook.url", "steps.note.to", "trigger_config.webhook"]);

    const installed = await installListing(org.dataId, published.listing.id);
    expect(installed.created).toBe(true);
    const row = await sqlOne<{ enabled: boolean; status: string; trigger_type: string; steps: string }>(`SELECT enabled, status, trigger_type, steps FROM automations WHERE id::text = $1 AND user_id = $2`, [installed.entityId, org.dataId]);
    expect(row).toMatchObject({ enabled: false, status: "paused", trigger_type: "webhook" });
    expect(row?.steps).toContain(WEBHOOK_URL_PLACEHOLDER);

    // Editor round-trip: a PATCH echoing the redacted DTO leaves the stored token and secret untouched.
    const byId = await import("@/app/api/automations/[id]/route");
    const dto = await api<{ automation: AutomationDTO }>(byId.GET, `/api/automations/${src.id}`, { params: { id: src.id }, expect: 200 });
    expect(dto.body.automation.trigger_config.webhook?.token).toBe("inbound-token-abcdefgh"); // owner sees it
    const steps = dto.body.automation.steps.map((s) => (s.kind === "webhook" ? { ...s, config: { ...s.config, secret: REDACTED_SECRET, url: "https://hooks.example.com/t/NEW" } } : s));
    const patched = await api<{ automation: AutomationDTO }>(byId.PATCH, `/api/automations/${src.id}`, {
      method: "PATCH",
      json: { name: "Escalate hot tickets v2", trigger_config: { event_type: "ticket.created", webhook: { token: REDACTED_SECRET } }, steps },
      params: { id: src.id },
      expect: 200,
    });
    expect(patched.body.automation.name).toBe("Escalate hot tickets v2");
    const after = await sqlOne<{ trigger_config: string; steps: string; name: string; user_id: string; trigger_type: string | null; conditions: string | null; action_config: string | null; trigger_event: string | null; action_type: string | null; kanban_label: string | null; schedule_time: string | null; schedule_timezone: string | null; schedule_days: string | null; status: string | null; version: number | null; enabled: boolean | null; autonomy: string | null; description: string | null; template_key: string | null; run_count: number | null; error_count: number | null; last_run_at: string | null; last_error: string | null; created_at: string; updated_at: string | null; id: string }>(
      `SELECT id::text AS id, user_id, name, trigger_event, action_type, kanban_label, action_config, schedule_time, schedule_timezone, schedule_days, status, trigger_type, trigger_config, conditions, steps, version, enabled, autonomy, description, template_key, run_count, error_count, last_run_at, last_error, created_at, updated_at FROM automations WHERE id::text = $1`,
      [src.id]
    );
    const stored = definitionOf(after!);
    expect(stored.trigger_config.webhook?.token).toBe("inbound-token-abcdefgh");
    const hook = stored.steps.find((s) => s.id === "hook");
    expect(hook?.kind === "webhook" && hook.config.secret).toBe("signing-secret-1");
    expect(hook?.kind === "webhook" && hook.config.url).toBe("https://hooks.example.com/t/NEW");
    // Viewers only ever see the placeholder.
    setScope(org, { role: "viewer", userId: "itest-viewer" });
    const viewer = await api<{ automation: AutomationDTO }>(byId.GET, `/api/automations/${src.id}`, { params: { id: src.id }, expect: 200 });
    expect(viewer.body.automation.trigger_config.webhook?.token).toBe(REDACTED_SECRET);
    setScope(org);
  });
});
