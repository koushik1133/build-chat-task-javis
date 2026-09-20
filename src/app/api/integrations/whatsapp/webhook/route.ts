import type { NextRequest } from "next/server";
import { handleTwilioInbound } from "@/lib/twilio-webhook";

/** Twilio inbound whatsapp webhook. Signature-verified in the shared handler. */
export async function POST(req: NextRequest) {
  return handleTwilioInbound(req);
}
