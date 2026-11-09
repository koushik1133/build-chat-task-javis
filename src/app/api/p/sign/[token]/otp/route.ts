import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { paramToken, parseBody, publicRateLimit } from "@/lib/money/http";
import { requestSignOtp, SIGN_OTP_PURPOSES, SignLinkError } from "@/lib/documents/signing";

export const runtime = "nodejs";

const Body = z.object({ email: z.string().trim().email().max(320), purpose: z.enum(SIGN_OTP_PURPOSES as [string, ...string[]]).optional() }).strict();

/** POST /api/p/sign/[token]/otp — email a 6-digit code (purpose-scoped: sign | decline). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const limited = await publicRateLimit(req, "sign-otp", 20);
  if (limited) return limited;
  try {
    const body = await parseBody(req, Body, 4_096);
    if (!body.ok) return body.res;
    const out = await requestSignOtp(await paramToken(ctx), body.data.email, body.data.purpose === "decline" ? "decline" : "sign");
    return NextResponse.json(out);
  } catch (err) {
    if (err instanceof SignLinkError) return NextResponse.json({ error: err.code }, { status: err.code === "expired" ? 410 : 404 });
    const msg = err instanceof Error ? err.message : "error";
    if (err instanceof Error && err.name !== "DbError") return NextResponse.json({ error: "bad_request", detail: msg }, { status: 400 });
    console.error("[p.sign.otp]", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
