import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/supabase/server";
import { processInbound } from "@/lib/twilio-webhook";
import { rateLimit } from "@/lib/request-limits";

const bodySchema = z.object({
  fromNumber: z.string().trim().min(3).max(40),
  text: z.string().trim().min(1).max(2000),
  channel: z.enum(["sms", "whatsapp", "voice"]).default("sms"),
});

/**
 * Runs the inbound receptionist pipeline against the caller's own account
 * without Twilio, so the messaging inbox can be demoed end to end.
 */
export async function POST(req: NextRequest) {
  let user;
  try {
    ({ user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!rateLimit(`msg-sim:${user.id}`, 30, 60_000).allowed) {
    return NextResponse.json({ error: "Too many simulated messages — slow down." }, { status: 429 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  }

  try {
    const out = await processInbound({
      userId: user.id,
      channel: parsed.data.channel,
      fromNumber: parsed.data.fromNumber,
      text: parsed.data.text,
    });
    return NextResponse.json({
      conversation: {
        id: out.conversationId,
        channel: parsed.data.channel,
        from_number: parsed.data.fromNumber,
        messages: JSON.stringify(out.messages),
        updated_at: new Date().toISOString(),
      },
      result: out.result,
    });
  } catch (err) {
    console.error("[messaging/simulate] failed:", err);
    return NextResponse.json({ error: "Could not simulate that message." }, { status: 500 });
  }
}
