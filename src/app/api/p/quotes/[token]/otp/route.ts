import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { resolveShareToken } from "@/lib/share-tokens";
import { OTP_PURPOSES, requestAcceptanceOtp } from "@/lib/money/acceptance";
import { paramToken, parseBody, publicRateLimit } from "@/lib/money/http";

export const runtime = "nodejs";

/** `purpose` selects which action the code unlocks; accept and decline codes are not interchangeable. */
const Body = z.object({ email: z.string().trim().email().max(200), purpose: z.enum(OTP_PURPOSES as [string, ...string[]]).optional() }).strict();

export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const limited = await publicRateLimit(req, "quote-otp", 20);
  if (limited) return limited;
  try {
    const share = await resolveShareToken("quote", await paramToken(ctx));
    if (!share) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const body = await parseBody(req, Body, 4_096);
    if (!body.ok) return body.res;
    const out = await requestAcceptanceOtp(share.entity_id, body.data.email, body.data.purpose === "decline" ? "decline" : "accept", share.recipient ?? null);
    return NextResponse.json(out);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    if (err instanceof Error && err.name !== "DbError") return NextResponse.json({ error: "bad_request", detail: msg }, { status: 400 });
    console.error("[p.quotes.otp]", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
