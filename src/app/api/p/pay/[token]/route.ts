import { randomUUID } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { queryOne } from "@/lib/dsql";
import { resolveShareToken } from "@/lib/share-tokens";
import { getInvoiceById } from "@/lib/money/invoices";
import { toPublicInvoice } from "@/lib/money/public";
import { activeProviderId } from "@/lib/payments";
import { signSimulatedBody } from "@/lib/payments/simulated";
import { processWebhook } from "@/lib/payments/webhook";
import { paramToken, parseBody, publicRateLimit } from "@/lib/money/http";

export const runtime = "nodejs";

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const limited = publicRateLimit(req, "pay");
  if (limited) return limited;
  try {
    const share = await resolveShareToken("pay", await paramToken(ctx));
    if (!share) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const inv = await getInvoiceById(share.entity_id);
    if (!inv) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({
      invoice: await toPublicInvoice(inv, share.user_id),
      provider: activeProviderId(),
      outstanding_minor: Math.max(inv.total_minor - inv.paid_minor, 0),
    });
  } catch (err) {
    console.error("[p.pay.GET]", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

const Body = z.object({ outcome: z.enum(["success", "failure"]) });

/**
 * Simulated checkout only. Builds a provider event, signs it exactly like an
 * external webhook would be, and runs it through the same verified path.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const limited = publicRateLimit(req, "pay-sim", 20);
  if (limited) return limited;
  if (activeProviderId() !== "simulated") return NextResponse.json({ error: "not_simulated" }, { status: 400 });
  try {
    const token = await paramToken(ctx);
    const share = await resolveShareToken("pay", token);
    if (!share) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const body = await parseBody(req, Body, 1_024);
    if (!body.ok) return body.res;
    const inv = await getInvoiceById(share.entity_id);
    if (!inv) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const outstanding = Math.max(inv.total_minor - inv.paid_minor, 0);
    const pending = await queryOne<{ provider_ref: string | null }>(
      `SELECT provider_ref FROM invoice_payments WHERE invoice_id = $1 AND provider = 'simulated' ORDER BY created_at DESC LIMIT 1`,
      [inv.id]
    );
    const raw = JSON.stringify({
      type: body.data.outcome === "success" ? "payment.succeeded" : "payment.failed",
      event_id: `sim_evt_${randomUUID()}`,
      provider_ref: pending?.provider_ref ?? `sim_${token.slice(0, 24)}`,
      invoice_id: inv.id,
      amount_minor: outstanding,
      currency: inv.currency,
    });
    const headers = new Headers({ "x-simulated-signature": signSimulatedBody(raw) });
    const out = await processWebhook("simulated", raw, headers);
    if (out.status !== 200) return NextResponse.json(out.body, { status: out.status });
    const fresh = await getInvoiceById(inv.id);
    return NextResponse.json({ ok: true, status: fresh?.status ?? inv.status, invoice: fresh ? await toPublicInvoice(fresh, share.user_id) : null });
  } catch (err) {
    console.error("[p.pay.POST]", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
