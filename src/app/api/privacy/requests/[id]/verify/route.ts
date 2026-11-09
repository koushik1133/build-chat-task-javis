import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { sendVerification, verifyRequest } from "@/lib/privacy/dsr";
import { privacyError, privacyScope } from "../../../_lib";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const Schema = z.object({ code: z.string().trim().regex(/^\d{6}$/).optional() }).strict();

/** POST {} → emails an OTP to the subject; POST {code} → verifies it. */
export async function POST(req: NextRequest, ctx: Ctx) {
  const s = await privacyScope(true);
  if ("res" in s) return s.res;
  const parsed = Schema.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json({ error: "code must be 6 digits" }, { status: 400 });
  try {
    const { id } = await ctx.params;
    if (!parsed.data.code) {
      const out = await sendVerification(s.scope.dataId, id);
      return NextResponse.json({ sent: true, expiresAt: out.expiresAt });
    }
    const request = await verifyRequest(s.scope.dataId, id, parsed.data.code, s.scope.userId);
    return NextResponse.json({ request });
  } catch (err) {
    return privacyError(err, "verify request");
  }
}
