import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { registerTool } from "@/lib/agents/registry";
import type { ToolResult } from "@/lib/agents/types";

/** Site-lead tools (contact-form captures from generated sites). */

const STATUSES = ["new", "draft_ready", "sent", "archived"] as const;

const LEAD_COLS =
  "id, site_id, data, status, research_summary, draft_email_subject, draft_email_body, created_at, sent_at, enriched_at, follow_up_at";

interface LeadRow {
  id: string;
  site_id: string;
  data: string;
  status: string | null;
  research_summary: string | null;
  draft_email_subject: string | null;
  draft_email_body: string | null;
  created_at: string;
  sent_at: string | null;
  enriched_at: string | null;
  follow_up_at: string | null;
}

function fail(error: string): ToolResult {
  return { ok: false, summary: error, error };
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseLead(row: LeadRow) {
  let fields: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.data);
    if (parsed && typeof parsed === "object") fields = parsed as Record<string, unknown>;
  } catch {
    fields = { raw: row.data.slice(0, 500) };
  }
  return { ...row, data: fields };
}

/* ---------- leads.list ---------- */
const ListInput = z.object({ status: z.enum(STATUSES).optional() });
type ListInputT = z.infer<typeof ListInput>;

registerTool<ListInputT>({
  name: "leads.list",
  module: "leads",
  description: "List the 25 most recent captured site leads, optionally filtered by status (new|draft_ready|sent|archived).",
  input: ListInput,
  parameters: { type: "object", properties: { status: { type: "string", enum: [...STATUSES] } } },
  scope: "read",
  preview: (i) => `List leads${i.status ? ` (${i.status})` : ""}`,
  async run(ctx, input) {
    try {
      const params: unknown[] = [ctx.userId];
      let sql = `SELECT ${LEAD_COLS} FROM site_leads WHERE user_id = $1`;
      if (input.status) {
        params.push(input.status);
        sql += ` AND COALESCE(status, 'new') = $${params.length}`;
      }
      sql += ` ORDER BY created_at DESC LIMIT 25`;
      const rows = await query<LeadRow>(sql, params);
      const data = rows.map((r) => {
        const p = parseLead(r);
        return { ...p, research_summary: p.research_summary?.slice(0, 400) ?? null, draft_email_body: undefined };
      });
      return { ok: true, data, summary: `Found ${rows.length} lead(s)` };
    } catch (err) {
      return fail(`List failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- leads.get ---------- */
const GetInput = z.object({ id: z.string().min(1) });
type GetInputT = z.infer<typeof GetInput>;

registerTool<GetInputT>({
  name: "leads.get",
  module: "leads",
  description: "Fetch one site lead by id, including form data, research summary and drafted email.",
  input: GetInput,
  parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  scope: "read",
  preview: (i) => `Get lead ${i.id}`,
  async run(ctx, input) {
    try {
      const row = await queryOne<LeadRow>(`SELECT ${LEAD_COLS} FROM site_leads WHERE id = $1 AND user_id = $2`, [
        input.id,
        ctx.userId,
      ]);
      if (!row) return fail("Lead not found");
      return { ok: true, data: parseLead(row), summary: `Lead ${row.id} (${row.status ?? "new"})` };
    } catch (err) {
      return fail(`Lookup failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- leads.mark_status ---------- */
const MarkInput = z.object({ id: z.string().min(1), status: z.enum(STATUSES) });
type MarkInputT = z.infer<typeof MarkInput>;

registerTool<MarkInputT>({
  name: "leads.mark_status",
  module: "leads",
  description: "Set a lead's status to new, draft_ready, sent or archived.",
  input: MarkInput,
  parameters: {
    type: "object",
    properties: { id: { type: "string" }, status: { type: "string", enum: [...STATUSES] } },
    required: ["id", "status"],
  },
  scope: "write",
  requiresApproval: false,
  preview: (i) => `Mark lead ${i.id} as ${i.status}`,
  async run(ctx, input) {
    try {
      const row = await queryOne<{ id: string; status: string }>(
        `UPDATE site_leads SET status = $1${input.status === "sent" ? ", sent_at = COALESCE(sent_at, NOW())" : ""}
         WHERE id = $2 AND user_id = $3 RETURNING id, status`,
        [input.status, input.id, ctx.userId]
      );
      if (!row) return fail("Lead not found");
      return { ok: true, data: row, summary: `Lead ${row.id} marked ${row.status}` };
    } catch (err) {
      return fail(`Update failed: ${errMsg(err)}`);
    }
  },
});
