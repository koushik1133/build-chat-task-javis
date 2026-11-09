import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { clientIp, paramToken, parseBody, publicRateLimit } from "@/lib/money/http";
import { signWithToken, SignLinkError } from "@/lib/documents/signing";

export const runtime = "nodejs";

const Body = z
  .object({
    otp: z.string().trim().regex(/^\d{6}$/, "6-digit code expected"),
    email: z.string().trim().email().max(320),
    signature_text: z.string().trim().min(1).max(200),
    name: z.string().trim().max(200).optional(),
    /** Must be true: the consent checkbox on the page. */
    consent: z.literal(true),
  })
  .strict();

/** POST /api/p/sign/[token]/sign — verify the code, record the typed signature + consent, advance the flow. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const limited = await publicRateLimit(req, "sign-sign", 30);
  if (limited) return limited;
  try {
    const body = await parseBody(req, Body, 8_192);
    if (!body.ok) return body.res;
    const out = await signWithToken(await paramToken(ctx), {
      otp: body.data.otp,
      email: body.data.email,
      signature_text: body.data.signature_text,
      name: body.data.name ?? null,
      ip: clientIp(req),
      userAgent: req.headers.get("user-agent"),
    });
    return NextResponse.json(out);
  } catch (err) {
    if (err instanceof SignLinkError) return NextResponse.json({ error: err.code }, { status: err.code === "expired" ? 410 : 404 });
    const msg = err instanceof Error ? err.message : "error";
    if (err instanceof Error && err.name !== "DbError") return NextResponse.json({ error: "bad_request", detail: msg }, { status: 400 });
    console.error("[p.sign.sign]", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
