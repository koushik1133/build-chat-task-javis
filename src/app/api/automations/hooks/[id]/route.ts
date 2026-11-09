import { NextResponse } from "next/server";
import { queryOne } from "@/lib/dsql";
import { rateLimitAsync, readCappedText } from "@/lib/request-limits";
import { AUTOMATION_COLS, type AutomationRow } from "@/lib/automations/store";
import { enqueueWebhookRun } from "@/lib/automations/triggers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public inbound trigger for `trigger_type = "webhook"` automations:
 *   POST /api/automations/hooks/{id}?token=…   (or X-Automation-Token header)
 * The JSON body becomes `event.data`. Unknown id / bad token → 404 so the
 * endpoint does not reveal which automations exist.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const rl = await rateLimitAsync(`automations:hook:${id}`, 120, 60_000);
  if (!rl.allowed) return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  const url = new URL(req.url);
  const token = req.headers.get("x-automation-token") ?? url.searchParams.get("token");
  const row = await queryOne<AutomationRow>(`SELECT ${AUTOMATION_COLS} FROM automations WHERE id::text = $1`, [id]).catch(() => null);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  const text = await readCappedText(req, 64 * 1024).catch(() => null);
  if (text === null) return NextResponse.json({ error: "body too large" }, { status: 413 });
  let body: Record<string, unknown> = {};
  if (text.trim()) {
    try {
      const v: unknown = JSON.parse(text);
      body = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
    } catch {
      return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
    }
  }
  const runId = await enqueueWebhookRun(row, token, body).catch(() => null);
  if (!runId) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true, run_id: runId }, { status: 202 });
}
