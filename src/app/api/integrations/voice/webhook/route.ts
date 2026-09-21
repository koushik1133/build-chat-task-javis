import { NextRequest, NextResponse } from "next/server";
import { queryOne } from "@/lib/dsql";
import { authorizeTwilioRequest } from "@/lib/twilio-webhook";
import { gatherSpeech, greeting, sayAndHangup, twimlResponse } from "@/lib/receptionist/voice";

/**
 * Twilio Voice: first webhook of an inbound call. Greets the caller and
 * gathers speech for `/api/integrations/voice/turn`.
 */
export async function POST(req: NextRequest) {
  try {
    const params = new URLSearchParams(await req.text());
    const toNumber = params.get("To") ?? "";
    if (!toNumber) return twimlResponse(sayAndHangup("Sorry, this number is not in service. Goodbye."));

    const auth = await authorizeTwilioRequest(req, params, toNumber, () =>
      twimlResponse(sayAndHangup("Sorry, this number is not in service. Goodbye."))
    );
    if (auth instanceof NextResponse) return auth;

    const profile = await queryOne<{ company_name: string | null }>(
      `SELECT company_name FROM business_profile WHERE user_id = $1`,
      [auth.user_id]
    ).catch(() => null);

    return twimlResponse(gatherSpeech(greeting(profile?.company_name?.trim() || "our office"), 1));
  } catch (err) {
    console.error("[voice] webhook error:", err);
    return twimlResponse(sayAndHangup("Sorry, something went wrong. Please call back later."));
  }
}
