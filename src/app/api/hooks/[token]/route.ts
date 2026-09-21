import { createHash } from "crypto";
import { NextResponse } from "next/server";
import { queryOne } from "@/lib/dsql";
import { rateLimit, readCappedText } from "@/lib/request-limits";
import { startRun } from "@/lib/agents/runner";
import { parseTriggerConfig } from "@/lib/agents/triggers";

export const runtime = "nodejs";

/**
 * Public inbound webhook: `POST /api/hooks/<token>`.
 *
 * The token is the only credential; it is stored hashed and compared by hash,
 * so a database read never reveals it. Each trigger gets its own rate bucket
 * and the body is capped so a caller cannot turn one URL into unbounded spend.
 */

const MAX_BODY_BYTES = 32_768;

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!token || token.length < 16 || token.length > 128) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const hash = createHash("sha256").update(token).digest("hex");
  const trigger = await queryOne<{ id: string; user_id: string; agent_id: string; config: string | null }>(
    `SELECT id, user_id, agent_id, config FROM agent_triggers
     WHERE kind = 'webhook' AND secret_hash = $1 AND enabled = TRUE`,
    [hash]
  ).catch(() => null);
  if (!trigger) return NextResponse.json({ error: "not found" }, { status: 404 });

  const limit = rateLimit(`hook:${trigger.id}`, 60, 60_000);
  if (!limit.allowed) {
    return NextResponse.json({ error: "rate limited" }, { status: 429, headers: { "Retry-After": "60" } });
  }

  const body = await readCappedText(req, MAX_BODY_BYTES);
  if (body === null) return NextResponse.json({ error: "payload too large" }, { status: 413 });

  const config = parseTriggerConfig(trigger.config);
  const base = typeof config.prompt === "string" && config.prompt.trim() ? config.prompt.trim() : "Webhook received";
  const prompt = `${base}\n\nPayload:\n${body.trim() || "(empty)"}`;

  try {
    const runId = await startRun(trigger.user_id, trigger.agent_id, {
      prompt,
      triggerKind: "webhook",
      triggerRef: trigger.id,
      workflowName: "Webhook",
    });
    return NextResponse.json({ runId }, { status: 202 });
  } catch (err) {
    console.error(`[hooks] failed to start run for trigger ${trigger.id}:`, err);
    return NextResponse.json({ error: "failed to queue run" }, { status: 500 });
  }
}
