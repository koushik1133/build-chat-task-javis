import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { recordOptOut } from "@/lib/voice/campaigns";

export const dynamic = "force-dynamic";

const schema = z
  .object({
    phone: z.string().min(5).max(30).optional().nullable(),
    email: z.string().email().max(200).optional().nullable(),
    contact_id: z.string().min(1).max(100).optional().nullable(),
    channel: z.enum(["voice", "sms", "email", "all"]).default("voice"),
    reason: z.string().max(300).optional().nullable(),
  })
  .strict()
  .refine((v) => v.phone || v.email || v.contact_id, { message: "Provide a phone, email or contact_id." });

/** Add someone to the do-not-call / do-not-contact list. */
export async function POST(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "crm", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  try {
    const id = await recordOptOut(scope.dataId, parsed.data);
    return NextResponse.json({ ok: true, id }, { status: 201 });
  } catch (err) {
    console.error("[contacts/optout] failed:", err);
    return NextResponse.json({ error: "Could not record the opt-out." }, { status: 500 });
  }
}
