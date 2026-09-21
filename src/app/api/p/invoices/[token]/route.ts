import { NextResponse, type NextRequest } from "next/server";
import { resolveShareToken } from "@/lib/share-tokens";
import { getInvoiceById } from "@/lib/money/invoices";
import { toPublicInvoice } from "@/lib/money/public";
import { activeProviderId } from "@/lib/payments";
import { paramToken, publicRateLimit } from "@/lib/money/http";

export const runtime = "nodejs";

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const limited = publicRateLimit(req, "invoice");
  if (limited) return limited;
  try {
    const share = await resolveShareToken("invoice", await paramToken(ctx));
    if (!share) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const inv = await getInvoiceById(share.entity_id);
    if (!inv) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ invoice: await toPublicInvoice(inv, share.user_id), provider: activeProviderId() });
  } catch (err) {
    console.error("[p.invoices.GET]", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

/** Client-initiated pay: mint a checkout for the outstanding balance and return its URL. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const limited = publicRateLimit(req, "invoice-pay", 10);
  if (limited) return limited;
  try {
    const share = await resolveShareToken("invoice", await paramToken(ctx));
    if (!share) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const { createPayLink } = await import("@/lib/money/invoices");
    const out = await createPayLink(share.user_id, share.entity_id);
    return NextResponse.json({ url: out.url, provider: out.provider });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    if (err instanceof Error && err.name !== "DbError") return NextResponse.json({ error: "bad_request", detail: msg }, { status: 400 });
    console.error("[p.invoices.POST]", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
