import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { registerTool } from "@/lib/agents/registry";
import type { ToolResult } from "@/lib/agents/types";

/** Read-only access to saved strategy documents. */

const MAX_CONTENT = 6000;

interface StrategyRow {
  id: string;
  title: string;
  type: string;
  status: string;
  created_at: string;
  content?: string;
}

function fail(error: string): ToolResult {
  return { ok: false, summary: error, error };
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ---------- strategy.list ---------- */
const ListInput = z.object({
  type: z.string().max(40).optional(),
  status: z.enum(["draft", "published", "archived"]).optional(),
});
type ListInputT = z.infer<typeof ListInput>;

registerTool<ListInputT>({
  name: "strategy.list",
  module: "strategy",
  description: "List saved strategy documents (title, type, status) — up to 25, newest first.",
  input: ListInput,
  parameters: {
    type: "object",
    properties: { type: { type: "string" }, status: { type: "string", enum: ["draft", "published", "archived"] } },
  },
  scope: "read",
  preview: (i) => `List strategies${i.type ? ` of type ${i.type}` : ""}`,
  async run(ctx, input) {
    try {
      const params: unknown[] = [ctx.userId];
      let sql = `SELECT id, title, type, status, created_at, LEFT(content, 200) AS excerpt FROM strategies WHERE user_id = $1`;
      if (input.type) {
        params.push(input.type);
        sql += ` AND type = $${params.length}`;
      }
      if (input.status) {
        params.push(input.status);
        sql += ` AND status = $${params.length}`;
      }
      sql += ` ORDER BY created_at DESC LIMIT 25`;
      const rows = await query<StrategyRow & { excerpt: string }>(sql, params);
      return { ok: true, data: rows, summary: `Found ${rows.length} strateg${rows.length === 1 ? "y" : "ies"}` };
    } catch (err) {
      return fail(`List failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- strategy.get ---------- */
const GetInput = z.object({ id: z.string().min(1) });
type GetInputT = z.infer<typeof GetInput>;

registerTool<GetInputT>({
  name: "strategy.get",
  module: "strategy",
  description: `Fetch one strategy document by id (content truncated to ${MAX_CONTENT} characters).`,
  input: GetInput,
  parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  scope: "read",
  preview: (i) => `Get strategy ${i.id}`,
  async run(ctx, input) {
    try {
      const row = await queryOne<StrategyRow>(
        `SELECT id, title, type, status, created_at, content FROM strategies WHERE id = $1 AND user_id = $2`,
        [input.id, ctx.userId]
      );
      if (!row) return fail("Strategy not found");
      const content = row.content ?? "";
      const truncated = content.length > MAX_CONTENT;
      return {
        ok: true,
        data: { ...row, content: truncated ? `${content.slice(0, MAX_CONTENT)}\n\n[truncated]` : content, truncated },
        summary: `Strategy "${row.title}" (${row.type})`,
      };
    } catch (err) {
      return fail(`Lookup failed: ${errMsg(err)}`);
    }
  },
});
