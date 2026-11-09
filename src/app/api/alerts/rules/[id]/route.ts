import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { query } from "@/lib/dsql";
import { recordAudit } from "@/lib/audit";
import { getRule, isAllowedAlertEmail, toView } from "@/lib/alerts/store";
import { getIntegrationRow } from "@/lib/chatops/subscriptions";

export const runtime = "nodejs";

const bodySchema = z.object({
  enabled: z.boolean().optional(),
  threshold: z.number().finite().min(0).max(1_000_000).optional(),
  window_min: z.number().int().min(1).max(10_080).optional(),
  cooldown_min: z.number().int().min(1).max(10_080).optional(),
  channel_ids: z.array(z.string().min(1).max(200)).max(10).optional(),
}).strict();

/** PATCH /api/alerts/rules/:id — toggle, edit threshold/window/cooldown/channels. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let scope;
  try { scope = await requireScope({ area: "settings", edit: true }); } catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const { id } = await ctx.params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, { status: 400 });
  const row = await getRule(scope.dataId, id);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  const view = toView(row);
  if (!view) return NextResponse.json({ error: "rule is malformed" }, { status: 422 });
  const b = parsed.data;

  let channels = view.channel_ids;
  if (b.channel_ids) {
    channels = [];
    for (const c of b.channel_ids) {
      if (c.startsWith("email:")) {
        if (!(await isAllowedAlertEmail(scope, c.slice(6)))) return NextResponse.json({ error: "Alert emails can only go to you or an active member of this workspace." }, { status: 400 });
        channels.push(`email:${c.slice(6).trim().toLowerCase()}`);
      } else if (await getIntegrationRow(scope.dataId, c)) channels.push(c);
      else return NextResponse.json({ error: "Unknown chat integration" }, { status: 400 });
    }
  }
  const condition = { ...view.condition, threshold: b.threshold ?? view.condition.threshold, window_min: b.window_min ?? view.condition.window_min };
  const enabled = b.enabled ?? view.enabled;
  await query(
    `UPDATE alert_rules SET condition = $3, channel_ids = $4, enabled = $5, cooldown_min = $6 WHERE id = $1 AND user_id = $2`,
    [id, scope.dataId, JSON.stringify(condition), JSON.stringify(channels), enabled, b.cooldown_min ?? view.cooldown_min]
  );
  if (!enabled) await query(`UPDATE alert_events SET resolved_at = NOW() WHERE rule_id = $1 AND resolved_at IS NULL`, [id]).catch(() => undefined);
  await recordAudit(scope, { action: "update", entity: "alert_rule", entityId: id, before: { enabled: view.enabled, threshold: view.condition.threshold }, after: { enabled, threshold: condition.threshold } });
  const fresh = await getRule(scope.dataId, id);
  return NextResponse.json({ rule: fresh ? toView(fresh) : null });
}
