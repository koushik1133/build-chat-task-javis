import { NextResponse, type NextRequest } from "next/server";
import { clientIp, rateLimitAsync, readCappedText } from "@/lib/request-limits";
import { withRequestContext } from "@/lib/log/context";
import { getTaxRate } from "@/lib/money/tax-rates";
import { MembershipError, getPlanBySlug, resolveOrgBySlug, seatsUsed } from "@/lib/memberships/plans";
import { SubscribeSchema, subscribe } from "@/lib/memberships/subscriptions";
import { getBranding } from "@/lib/branding";
import { logger } from "@/lib/log/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;
type Ctx = { params: Promise<{ org: string; plan: string }> };

const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });

/** GET /api/join/[org]/[plan] — public plan details (archived plans 404). */
async function getHandler(req: NextRequest, ctx: Ctx) {
  if (!(await rateLimitAsync(`join:get:${clientIp(req)}`, 120, 60_000)).allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: NO_STORE });
  try {
    const { org: orgSlug, plan: planSlug } = await ctx.params;
    const org = await resolveOrgBySlug(orgSlug);
    if (!org) return notFound();
    const plan = await getPlanBySlug(org.dataId, planSlug.toLowerCase());
    if (!plan || !plan.active) return notFound();
    const [tax, used, branding] = await Promise.all([
      plan.tax_rate_id ? getTaxRate(org.dataId, plan.tax_rate_id).catch(() => null) : Promise.resolve(null),
      plan.max_members !== null ? seatsUsed(plan.id) : Promise.resolve(0),
      getBranding(org.dataId).catch(() => null),
    ]);
    return NextResponse.json(
      {
        org: { name: branding?.brand_name ?? org.name },
        plan: {
          slug: plan.slug,
          name: plan.name,
          description_md: plan.description_md,
          amount_minor: plan.amount_minor,
          currency: plan.currency,
          interval: plan.interval,
          interval_count: plan.interval_count,
          trial_days: plan.trial_days,
          setup_fee_minor: plan.setup_fee_minor,
          benefits: plan.benefits,
          allow_quantity: plan.allow_quantity,
          full: plan.max_members !== null && used >= plan.max_members,
          tax: tax ? { name: tax.name, rate_bp: tax.rate_bp } : null,
        },
      },
      { headers: NO_STORE }
    );
  } catch (err) {
    logger.error("join GET failed", { err: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

/**
 * POST /api/join/[org]/[plan] — { contact:{name,email,phone?}, quantity?, consent:{terms:true, marketing?} }.
 * The response never says whether the email already belonged to a contact.
 */
async function postHandler(req: NextRequest, ctx: Ctx) {
  const ip = clientIp(req);
  if (!(await rateLimitAsync(`join:post:${ip}`, 10, 60_000)).allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: NO_STORE });
  try {
    const { org: orgSlug, plan: planSlug } = await ctx.params;
    const text = await readCappedText(req, 8_192);
    if (text === null) return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
    let json: unknown;
    try {
      json = JSON.parse(text || "{}");
    } catch {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }
    const parsed = SubscribeSchema.safeParse(json);
    if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400, headers: NO_STORE });
    if (!(await rateLimitAsync(`join:email:${parsed.data.contact.email}`, 5, 3_600_000)).allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: NO_STORE });
    const org = await resolveOrgBySlug(orgSlug);
    if (!org) return notFound();
    const out = await subscribe(org.dataId, planSlug.toLowerCase(), parsed.data, { ip, ua: req.headers.get("user-agent") });
    return NextResponse.json({ status: out.status, pay_url: out.pay_url, trial_ends_at: out.trial_ends_at }, { status: 201, headers: NO_STORE });
  } catch (err) {
    if (err instanceof MembershipError) return NextResponse.json({ error: err.code, detail: err.message }, { status: err.status, headers: NO_STORE });
    logger.error("join POST failed", { err: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

export const GET = withRequestContext(getHandler);
export const POST = withRequestContext(postHandler);
