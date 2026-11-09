import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/lib/auth/scope";
import { query } from "@/lib/dsql";
import { parseBody } from "@/lib/money/http";
import { recordAudit } from "@/lib/audit";
import { billNow } from "@/lib/memberships/billing";
import { memberErrorResponse } from "@/lib/memberships/http";
import { cancelSubscription, changeSubscription, keepSubscription, pauseSubscription, resumeSubscription } from "@/lib/memberships/subscriptions";
import { getSubscription, listCharges } from "@/lib/memberships/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET — subscription + charge timeline + linked invoices. */
export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: false });
    const { id } = await ctx.params;
    const subscription = await getSubscription(scope.dataId, id);
    if (!subscription) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const charges = await listCharges(scope.dataId, id);
    const invoices = await query<{ id: string; number: string; status: string; total_minor: string | number; currency: string; created_at: string }>(
      `SELECT i.id, i.number, i.status, i.total_minor, i.currency, i.created_at FROM invoices i
        WHERE i.user_id = $1 AND i.id IN (SELECT invoice_id FROM subscription_charges WHERE subscription_id = $2 AND invoice_id IS NOT NULL) ORDER BY i.created_at DESC LIMIT 50`,
      [scope.dataId, id]
    );
    return NextResponse.json({ subscription, charges, invoices: invoices.map((i) => ({ ...i, total_minor: Number(i.total_minor) })) });
  } catch (err) {
    return memberErrorResponse(err, "memberships.subscription.GET");
  }
}

const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause"), until: z.string().datetime({ offset: true }).nullable().optional() }).strict(),
  z.object({ action: z.literal("resume") }).strict(),
  z.object({ action: z.literal("cancel"), at_period_end: z.boolean().default(true), reason: z.string().max(300).nullable().optional() }).strict(),
  z.object({ action: z.literal("keep") }).strict(),
  z.object({ action: z.literal("change"), plan_slug: z.string().max(80).optional(), quantity: z.number().int().min(1).max(100).optional() }).strict(),
  z.object({ action: z.literal("retry") }).strict(),
]);

/** POST — { action: pause|resume|cancel|keep|change|retry, ... } */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const { id } = await ctx.params;
    const body = await parseBody(req, ActionSchema);
    if (!body.ok) return body.res;
    const a = body.data;
    let extra: Record<string, unknown> = {};
    switch (a.action) {
      case "pause":
        await pauseSubscription(scope.dataId, id, { until: a.until ? new Date(a.until) : null });
        break;
      case "resume":
        await resumeSubscription(scope.dataId, id);
        break;
      case "cancel":
        await cancelSubscription(scope.dataId, id, { atPeriodEnd: a.at_period_end, by: "staff", reason: a.reason ?? null });
        break;
      case "keep":
        await keepSubscription(scope.dataId, id);
        break;
      case "change": {
        const r = await changeSubscription(scope.dataId, id, { planSlug: a.plan_slug, quantity: a.quantity });
        extra = { proration_minor: r.proration_minor };
        break;
      }
      case "retry":
        extra = { billing: await billNow(scope.dataId, id) };
        break;
    }
    await recordAudit(scope, { action: `membership.${a.action}`, entity: "customer_subscription", entityId: id, req });
    const subscription = await getSubscription(scope.dataId, id);
    if (!subscription) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ subscription, ...extra });
  } catch (err) {
    return memberErrorResponse(err, "memberships.subscription.POST");
  }
}
