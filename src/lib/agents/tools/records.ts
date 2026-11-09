import { z } from "zod";
import { registerTool } from "@/lib/agents/registry";
import type { ToolResult } from "@/lib/agents/types";
import { createRecord, getType, listRecords, listTypes, moveRecord, updateRecord } from "@/lib/records/store";

/**
 * Records tools: configurable record types (patients, matters, jobs, …).
 * Every query is scoped to ctx.userId, which the runner sets to the org data id.
 */

function fail(error: string): ToolResult {
  return { ok: false, summary: error, error };
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ---------- records.list_types ---------- */
const ListTypesInput = z.object({});
type ListTypesT = z.infer<typeof ListTypesInput>;

registerTool<ListTypesT>({
  name: "records.list_types",
  module: "records",
  description: "List the workspace's record types (e.g. patients, matters, jobs) with their fields and stages. Call this first to learn what records exist.",
  input: ListTypesInput,
  parameters: { type: "object", properties: {} },
  scope: "read",
  preview: () => "List record types",
  async run(ctx) {
    try {
      const types = await listTypes(ctx.userId);
      const data = types.map((t) => ({
        slug: t.slug,
        name: t.name,
        description: t.description,
        fields: t.fields.map((f) => ({ key: f.key, label: f.label, type: f.type, required: !!f.required, options: f.options })),
        stages: t.stages.map((s) => ({ key: s.key, label: s.label })),
      }));
      return { ok: true, data, summary: `${types.length} record type(s): ${types.map((t) => t.slug).join(", ") || "none"}` };
    } catch (err) {
      return fail(`List failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- records.search ---------- */
const SearchInput = z.object({
  type: z.string().min(1).max(60),
  query: z.string().max(200).optional(),
  stage: z.string().max(60).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
type SearchT = z.infer<typeof SearchInput>;

registerTool<SearchT>({
  name: "records.search",
  module: "records",
  description: "Search records of one type by free text, optionally filtered by stage. Returns up to 25 by default.",
  input: SearchInput,
  parameters: {
    type: "object",
    properties: {
      type: { type: "string", description: "Record type slug, e.g. 'patients'" },
      query: { type: "string", description: "Free-text match on title, summary or field values" },
      stage: { type: "string", description: "Stage key to filter by" },
      limit: { type: "number" },
    },
    required: ["type"],
  },
  scope: "read",
  preview: (i) => `Search ${i.type}${i.query ? ` for "${i.query}"` : ""}${i.stage ? ` in ${i.stage}` : ""}`,
  async run(ctx, input) {
    try {
      const type = await getType(ctx.userId, input.type);
      if (!type) return fail(`Record type "${input.type}" not found`);
      const records = await listRecords(ctx.userId, type, { q: input.query, stage: input.stage, limit: input.limit ?? 25 });
      const data = records.map((r) => ({
        id: r.id,
        title: r.title,
        stage: r.stage,
        summary: r.summary,
        data: r.data,
        amount_minor: r.amount_minor,
        due_at: r.due_at,
        updated_at: r.updated_at,
      }));
      return { ok: true, data, summary: `Found ${records.length} ${type.name.toLowerCase()} record(s)` };
    } catch (err) {
      return fail(`Search failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- records.create ---------- */
const CreateInput = z.object({
  type: z.string().min(1).max(60),
  title: z.string().min(1).max(300),
  stage: z.string().max(60).optional(),
  data: z.record(z.unknown()).optional(),
  summary: z.string().max(4000).optional(),
});
type CreateT = z.infer<typeof CreateInput>;

registerTool<CreateT>({
  name: "records.create",
  module: "records",
  description: "Create a record of a given type. `data` is keyed by the type's field keys (see records.list_types). Money fields accept major units (e.g. 1250.50).",
  input: CreateInput,
  parameters: {
    type: "object",
    properties: {
      type: { type: "string" },
      title: { type: "string" },
      stage: { type: "string", description: "Stage key; defaults to the first stage" },
      data: { type: "object", description: "Field values keyed by field key" },
      summary: { type: "string" },
    },
    required: ["type", "title"],
  },
  scope: "write",
  requiresApproval: false,
  preview: (i) => `Create ${i.type} record "${i.title}"${i.stage ? ` in ${i.stage}` : ""}`,
  async run(ctx, input) {
    try {
      const type = await getType(ctx.userId, input.type);
      if (!type) return fail(`Record type "${input.type}" not found`);
      const record = await createRecord(ctx.userId, type, {
        title: input.title,
        stage: input.stage,
        data: input.data ?? {},
        summary: input.summary ?? null,
        actorId: ctx.agentId,
      });
      return { ok: true, data: record, summary: `Created ${type.name} "${record.title}" (${record.id})` };
    } catch (err) {
      return fail(`Create failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- records.move ---------- */
const MoveInput = z.object({
  type: z.string().min(1).max(60),
  id: z.string().min(1),
  stage: z.string().min(1).max(60),
});
type MoveT = z.infer<typeof MoveInput>;

registerTool<MoveT>({
  name: "records.move",
  module: "records",
  description: "Move a record to another stage of its workflow. Requires approval.",
  input: MoveInput,
  parameters: {
    type: "object",
    properties: { type: { type: "string" }, id: { type: "string" }, stage: { type: "string", description: "Target stage key" } },
    required: ["type", "id", "stage"],
  },
  scope: "write",
  requiresApproval: true,
  preview: (i) => `Move ${i.type} record ${i.id} to stage "${i.stage}"`,
  async run(ctx, input) {
    try {
      const type = await getType(ctx.userId, input.type);
      if (!type) return fail(`Record type "${input.type}" not found`);
      const record = await moveRecord(ctx.userId, type, input.id, input.stage, ctx.agentId);
      return { ok: true, data: record, summary: `Moved "${record.title}" to ${record.stage}` };
    } catch (err) {
      return fail(`Move failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- records.update ---------- */
const UpdateInput = z.object({
  type: z.string().min(1).max(60),
  id: z.string().min(1),
  title: z.string().min(1).max(300).optional(),
  data: z.record(z.unknown()).optional(),
  summary: z.string().max(4000).nullable().optional(),
});
type UpdateT = z.infer<typeof UpdateInput>;

registerTool<UpdateT>({
  name: "records.update",
  module: "records",
  description: "Update a record's title, summary or field values (partial update; unspecified fields are kept).",
  input: UpdateInput,
  parameters: {
    type: "object",
    properties: {
      type: { type: "string" },
      id: { type: "string" },
      title: { type: "string" },
      data: { type: "object", description: "Field values to change, keyed by field key" },
      summary: { type: "string" },
    },
    required: ["type", "id"],
  },
  scope: "write",
  requiresApproval: false,
  preview: (i) => `Update ${i.type} record ${i.id}: ${[i.title && "title", i.data && Object.keys(i.data).join(", "), i.summary !== undefined && "summary"].filter(Boolean).join(", ") || "no fields"}`,
  async run(ctx, input) {
    try {
      const type = await getType(ctx.userId, input.type);
      if (!type) return fail(`Record type "${input.type}" not found`);
      const record = await updateRecord(ctx.userId, type, input.id, {
        title: input.title,
        data: input.data,
        summary: input.summary,
        actorId: ctx.agentId,
      });
      return { ok: true, data: record, summary: `Updated "${record.title}"` };
    } catch (err) {
      return fail(`Update failed: ${errMsg(err)}`);
    }
  },
});

/* ═══ Phase 6: delete + link ═══ */
import { getRecord, link as linkRecord, softDeleteRecord } from "@/lib/records/store";
import { LINK_KINDS } from "@/lib/records/types";

const DeleteInput = z.object({ type: z.string().min(1).max(60), record_id: z.string().min(1).max(100) });
registerTool<z.infer<typeof DeleteInput>>({
  name: "records.delete",
  module: "records",
  description: "Soft-delete a record (recoverable by an admin). Always needs approval.",
  input: DeleteInput,
  parameters: { type: "object", properties: { type: { type: "string", description: "Record type slug" }, record_id: { type: "string" } }, required: ["type", "record_id"] },
  scope: "write",
  requiresApproval: true,
  preview: (i) => `Delete ${i.type} record ${i.record_id}`,
  async run(ctx, input) {
    try {
      const type = await getType(ctx.userId, input.type);
      if (!type) return fail(`Unknown record type "${input.type}"`);
      const rec = await getRecord(ctx.userId, input.record_id);
      if (!rec || rec.type_id !== type.id) return fail("Record not found");
      const ok = await softDeleteRecord(ctx.userId, type, input.record_id);
      return ok ? { ok: true, data: { id: input.record_id, deleted: true }, summary: `Deleted "${rec.title}"` } : fail("Record not found");
    } catch (err) {
      return fail(`Delete failed: ${errMsg(err)}`);
    }
  },
});

const LinkInput = z.object({
  record_id: z.string().min(1).max(100),
  target_kind: z.enum(LINK_KINDS),
  target_id: z.string().min(1).max(100),
});
registerTool<z.infer<typeof LinkInput>>({
  name: "records.link",
  module: "records",
  description: "Link a record to a contact, task, quote, invoice, booking or another record. Idempotent.",
  input: LinkInput,
  parameters: {
    type: "object",
    properties: { record_id: { type: "string" }, target_kind: { type: "string", enum: [...LINK_KINDS] }, target_id: { type: "string" } },
    required: ["record_id", "target_kind", "target_id"],
  },
  scope: "write",
  requiresApproval: false,
  preview: (i) => `Link record ${i.record_id} → ${i.target_kind} ${i.target_id}`,
  async run(ctx, input) {
    try {
      const rec = await getRecord(ctx.userId, input.record_id);
      if (!rec) return fail("Record not found");
      const row = await linkRecord(ctx.userId, input.record_id, input.target_kind, input.target_id, ctx.agentId ? `agent:${ctx.agentId}` : null);
      return { ok: true, data: { id: row.id, record_id: row.record_id, target_kind: row.target_kind, target_id: row.target_id }, summary: `Linked "${rec.title}" to ${input.target_kind} ${input.target_id}` };
    } catch (err) {
      return fail(`Link failed: ${errMsg(err)}`);
    }
  },
});
