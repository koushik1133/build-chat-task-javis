import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { query } from "@/lib/dsql";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let scope;
  try { scope = await requireScope({ area: "production", edit: false }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const { id } = await ctx.params;
  const activity = await query(
    `SELECT action, details, created_at FROM production_activity
     WHERE task_id = $1 AND user_id = $2
     ORDER BY created_at DESC LIMIT 50`,
    [id, scope.dataId]
  ).catch(() => []);

  type Row = { action: string; details: string; created_at: string };
  const rows = activity as Row[];

  return NextResponse.json({
    activity: rows.map(row => ({
      action: row.action,
      details: (() => { try { return JSON.parse(row.details || "{}"); } catch { return {}; } })(),
      created_at: row.created_at,
    })),
  });
}
