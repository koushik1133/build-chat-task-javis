import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { paramToken, parseBody, publicRateLimit } from "@/lib/money/http";
import { declineWithToken, SignLinkError } from "@/lib/documents/signing";
import { DocumentError } from "@/lib/documents/documents";

export const runtime = "nodejs";

const Body = z.object({ otp: z.string().trim().regex(/^\d{6}$/), email: z.string().trim().email().max(320), reason: z.string().trim().max(1000).nullable().optional() }).strict();

/** POST /api/p/sign/[token]/decline — OTP-gated decline (purpose = decline). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const limited = await publicRateLimit(req, "sign-decline", 30);
  if (limited) return limited;
  try {
    const body = await parseBody(req, Body, 8_192);
    if (!body.ok) return body.res;
    const document = await declineWithToken(await paramToken(ctx), { otp: body.data.otp, email: body.data.email, reason: body.data.reason ?? null });
    return NextResponse.json({ document });
  } catch (err) {
    if (err instanceof SignLinkError) return NextResponse.json({ error: err.code }, { status: err.code === "expired" ? 410 : 404 });
    if (err instanceof DocumentError) return NextResponse.json({ error: "bad_request", detail: err.message }, { status: err.status });
    console.error("[p.sign.decline]", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
