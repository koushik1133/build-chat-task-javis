import { createHash, randomBytes, randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/supabase/server";
import { query, queryOne } from "@/lib/dsql";
import { isValidCron } from "@/lib/cron-expr";
import { EVENT_TYPES } from "@/lib/events/bus";
import { computeNextRun, isValidTimezone, type TriggerRow } from "@/lib/agents/triggers";

export const runtime = "nodejs";

const configSchema = z.object({ prompt: z.string().max(20_000).optional() }).passthrough();

const cronField = z.string().trim().min(1).max(100).refine(isValidCron, "invalid cron expression");
const tzField = z.string().trim().min(1).max(64).refine(isValidTimezone, "invalid timezone");

const createSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("schedule"),
    cron_expr: cronField,
    timezone: tzField.default("UTC"),
    config: configSchema.optional(),
    enabled: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("event"),
    event_type: z.string().trim().min(1).max(120).refine((v) => (EVENT_TYPES as readonly string[]).includes(v), "unknown event type"),
    config: configSchema.optional(),
    enabled: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("webhook"),
    config: configSchema.optional(),
    enabled: z.boolean().optional(),
  }),
]);

const patchSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean().optional(),
  cron_expr: cronField.optional(),
  timezone: tzField.optional(),
  event_type: z.string().trim().min(1).max(120).optional(),
  config: configSchema.nullable().optional(),
});

function formatZodError(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
}

function publicTrigger(t: TriggerRow) {
  const { secret_hash: _secret, ...rest } = t as TriggerRow & { secret_hash?: string | null };
  void _secret;
  return rest;
}

function hookUrl(req: Request, token: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") || new URL(req.url).origin;
  return `${base}/api/hooks/${token}`;
}

async function ownsAgent(userId: string, agentId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(`SELECT id FROM agents WHERE id = $1 AND user_id = $2`, [agentId, userId]).catch(() => null);
  return !!row;
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const { id } = await ctx.params;
  if (!(await ownsAgent(user.id, id))) return NextResponse.json({ error: "not found" }, { status: 404 });

  const triggers = await query<TriggerRow>(
    `SELECT * FROM agent_triggers WHERE user_id = $1 AND agent_id = $2 ORDER BY created_at DESC`,
    [user.id, id]
  ).catch(() => []);
  return NextResponse.json({ triggers: triggers.map(publicTrigger) });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const { id } = await ctx.params;
  if (!(await ownsAgent(user.id, id))) return NextResponse.json({ error: "not found" }, { status: 404 });

  const rawBody = await req.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const parsed = createSchema.safeParse(rawBody);
  if (!parsed.success) return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  const body = parsed.data;

  const triggerId = randomUUID();
  const config = body.config ? JSON.stringify(body.config) : null;
  const enabled = body.enabled ?? true;

  let cronExpr: string | null = null;
  let timezone: string | null = null;
  let eventType: string | null = null;
  let secretHash: string | null = null;
  let nextRunAt: string | null = null;
  let token: string | null = null;

  if (body.kind === "schedule") {
    cronExpr = body.cron_expr;
    timezone = body.timezone;
    const next = computeNextRun(cronExpr, timezone);
    if (!next) return NextResponse.json({ error: "cron expression never fires" }, { status: 400 });
    nextRunAt = next.toISOString();
  } else if (body.kind === "event") {
    eventType = body.event_type;
  } else {
    token = randomBytes(24).toString("base64url");
    secretHash = createHash("sha256").update(token).digest("hex");
  }

  await query(
    `INSERT INTO agent_triggers (id, user_id, agent_id, kind, cron_expr, timezone, event_type, secret_hash, config, enabled, next_run_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [triggerId, user.id, id, body.kind, cronExpr, timezone, eventType, secretHash, config, enabled, nextRunAt]
  );

  const trigger = await queryOne<TriggerRow>(`SELECT * FROM agent_triggers WHERE id = $1 AND user_id = $2`, [triggerId, user.id]);
  if (!trigger) return NextResponse.json({ error: "failed to create trigger" }, { status: 500 });

  // The webhook token is shown exactly once; only its hash is stored.
  return NextResponse.json(
    {
      trigger: publicTrigger(trigger),
      ...(token ? { token, url: hookUrl(req, token) } : {}),
    },
    { status: 201 }
  );
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const { id } = await ctx.params;

  const rawBody = await req.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const parsed = patchSchema.safeParse(rawBody);
  if (!parsed.success) return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  const body = parsed.data;

  const existing = await queryOne<TriggerRow>(
    `SELECT * FROM agent_triggers WHERE id = $1 AND user_id = $2 AND agent_id = $3`,
    [body.id, user.id, id]
  ).catch(() => null);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (existing.kind === "event" && body.event_type && !(EVENT_TYPES as readonly string[]).includes(body.event_type)) {
    return NextResponse.json({ error: "unknown event type" }, { status: 400 });
  }

  const cronExpr = existing.kind === "schedule" ? body.cron_expr ?? existing.cron_expr : existing.cron_expr;
  const timezone = existing.kind === "schedule" ? body.timezone ?? existing.timezone ?? "UTC" : existing.timezone;
  const eventType = existing.kind === "event" ? body.event_type ?? existing.event_type : existing.event_type;
  const enabled = body.enabled ?? existing.enabled ?? true;
  const config = body.config === undefined ? existing.config : body.config === null ? null : JSON.stringify(body.config);

  let nextRunAt = existing.next_run_at;
  if (existing.kind === "schedule" && cronExpr && (body.cron_expr || body.timezone || (body.enabled && !existing.enabled))) {
    const next = computeNextRun(cronExpr, timezone ?? "UTC");
    if (!next) return NextResponse.json({ error: "cron expression never fires" }, { status: 400 });
    nextRunAt = next.toISOString();
  }

  await query(
    `UPDATE agent_triggers
     SET cron_expr = $3, timezone = $4, event_type = $5, config = $6, enabled = $7, next_run_at = $8
     WHERE id = $1 AND user_id = $2`,
    [existing.id, user.id, cronExpr, timezone, eventType, config, enabled, nextRunAt]
  );

  const trigger = await queryOne<TriggerRow>(`SELECT * FROM agent_triggers WHERE id = $1 AND user_id = $2`, [existing.id, user.id]);
  return NextResponse.json({ ok: true, trigger: trigger ? publicTrigger(trigger) : null });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const { id } = await ctx.params;

  const url = new URL(req.url);
  let triggerId = url.searchParams.get("triggerId") ?? url.searchParams.get("id");
  if (!triggerId) {
    const body = await req.json().catch(() => null);
    if (body && typeof body === "object" && typeof (body as { id?: unknown }).id === "string") {
      triggerId = (body as { id: string }).id;
    }
  }
  if (!triggerId) return NextResponse.json({ error: "trigger id required" }, { status: 400 });

  const row = await queryOne<{ id: string }>(
    `DELETE FROM agent_triggers WHERE id = $1 AND user_id = $2 AND agent_id = $3 RETURNING id`,
    [triggerId, user.id, id]
  ).catch(() => null);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
