import { randomUUID } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getPlanInvoiceByToken, isPlanInvoiceExpired, toPlanInvoiceDTO } from "@/lib/plans/checkout";
import { handlePlanPaymentEvent } from "@/lib/plans/webhook";
import { activeProviderId, getProvider, simulatedPaymentsAllowed } from "@/lib/payments";
import { signSimulatedBody } from "@/lib/payments/simulated";
import { paramToken, parseBody, publicRateLimit } from "@/lib/money/http";

export const runtime = "nodejs";

/** Public, token-scoped view of a plan invoice (the checkout / return page). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const limited = await publicRateLimit(req, "plan");
  if (limited) return limited;
  try {
    const inv = await getPlanInvoiceByToken(await paramToken(ctx));
    if (!inv) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (isPlanInvoiceExpired(inv)) return NextResponse.json({ error: "expired" }, { status: 410 });
    return NextResponse.json({ invoice: toPlanInvoiceDTO(inv), provider: activeProviderId() });
  } catch (err) {
    console.error("[p.plan.GET]", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

const Body = z.object({ outcome: z.enum(["success", "failure"]) });

/** Simulated checkout only: signs a provider event and applies it through the real verified path. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const limited = await publicRateLimit(req, "plan-sim", 20);
  if (limited) return limited;
  if (activeProviderId() !== "simulated" || !simulatedPaymentsAllowed()) return NextResponse.json({ error: "not_simulated" }, { status: 400 });
  try {
    const token = await paramToken(ctx);
    const inv = await getPlanInvoiceByToken(token);
    if (!inv) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (isPlanInvoiceExpired(inv)) return NextResponse.json({ error: "expired" }, { status: 410 });
    if (inv.provider !== "simulated") return NextResponse.json({ error: "not_simulated" }, { status: 400 });
    const body = await parseBody(req, Body, 1_024);
    if (!body.ok) return body.res;

    const raw = JSON.stringify({
      type: body.data.outcome === "success" ? "payment.succeeded" : "payment.failed",
      event_id: `sim_evt_${randomUUID()}`,
      provider_ref: inv.provider_ref ?? `sim_${token.slice(0, 24)}`,
      invoice_id: `plan:${inv.id}`,
      amount_minor: Number(inv.amount_minor),
      currency: inv.currency,
    });
    const verified = await getProvider("simulated").verifyWebhook(raw, new Headers({ "x-simulated-signature": signSimulatedBody(raw) }));
    if (!verified.ok || !verified.event) return NextResponse.json({ error: verified.error ?? "verification_failed" }, { status: 401 });

    const result = await handlePlanPaymentEvent("simulated", verified.event);
    const fresh = await getPlanInvoiceByToken(token);
    return NextResponse.json({ ok: true, status: fresh?.status ?? inv.status, activated: result?.activated ?? false, invoice: toPlanInvoiceDTO(fresh ?? inv) });
  } catch (err) {
    console.error("[p.plan.POST]", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
