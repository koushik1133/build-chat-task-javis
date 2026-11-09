import { randomUUID } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getPurchaseByToken, isPurchaseExpired, toPurchaseDTO } from "@/lib/credits/checkout";
import { handleCreditPaymentEvent } from "@/lib/credits/webhook";
import { activeProviderId, getProvider } from "@/lib/payments";
import { signSimulatedBody } from "@/lib/payments/simulated";
import { paramToken, parseBody, publicRateLimit } from "@/lib/money/http";

export const runtime = "nodejs";

/** Public, token-scoped view of a credit purchase (the checkout / return page). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const limited = await publicRateLimit(req, "credits");
  if (limited) return limited;
  try {
    const purchase = await getPurchaseByToken(await paramToken(ctx));
    if (!purchase) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (isPurchaseExpired(purchase)) return NextResponse.json({ error: "expired" }, { status: 410 });
    return NextResponse.json({ purchase: toPurchaseDTO(purchase), provider: activeProviderId() });
  } catch (err) {
    console.error("[p.credits.GET]", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

const Body = z.object({ outcome: z.enum(["success", "failure"]) });

/**
 * Simulated checkout only. Builds a provider event, signs it exactly like an
 * external webhook would be, verifies it through the provider and applies it
 * to the purchase — the same path a real provider's webhook takes.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const limited = await publicRateLimit(req, "credits-sim", 20);
  if (limited) return limited;
  if (activeProviderId() !== "simulated") return NextResponse.json({ error: "not_simulated" }, { status: 400 });
  try {
    const token = await paramToken(ctx);
    const purchase = await getPurchaseByToken(token);
    if (!purchase) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (isPurchaseExpired(purchase)) return NextResponse.json({ error: "expired" }, { status: 410 });
    if (purchase.provider !== "simulated") return NextResponse.json({ error: "not_simulated" }, { status: 400 });
    const body = await parseBody(req, Body, 1_024);
    if (!body.ok) return body.res;

    const raw = JSON.stringify({
      type: body.data.outcome === "success" ? "payment.succeeded" : "payment.failed",
      event_id: `sim_evt_${randomUUID()}`,
      provider_ref: purchase.provider_ref ?? `sim_${token.slice(0, 24)}`,
      invoice_id: `credits:${purchase.id}`,
      amount_minor: Number(purchase.amount_minor),
      currency: purchase.currency,
    });
    const verified = await getProvider("simulated").verifyWebhook(raw, new Headers({ "x-simulated-signature": signSimulatedBody(raw) }));
    if (!verified.ok || !verified.event) return NextResponse.json({ error: verified.error ?? "verification_failed" }, { status: 401 });

    const result = await handleCreditPaymentEvent("simulated", verified.event);
    const fresh = await getPurchaseByToken(token);
    return NextResponse.json({
      ok: true,
      status: fresh?.status ?? purchase.status,
      credited: result?.credited ?? false,
      purchase: fresh ? toPurchaseDTO(fresh) : toPurchaseDTO(purchase),
    });
  } catch (err) {
    console.error("[p.credits.POST]", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
