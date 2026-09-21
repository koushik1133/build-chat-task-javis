import { NextRequest, NextResponse } from "next/server";
import { authorizeTwilioRequest, processInbound } from "@/lib/twilio-webhook";
import { MAX_VOICE_TURNS, gatherSpeech, parseTurn, sayAndHangup, twimlResponse } from "@/lib/receptionist/voice";

/**
 * Twilio Voice: one conversational turn. Receives the caller's transcribed
 * speech, answers through the receptionist and re-gathers until the turn cap.
 */
export async function POST(req: NextRequest) {
  try {
    const params = new URLSearchParams(await req.text());
    const toNumber = params.get("To") ?? "";
    const fromNumber = params.get("From") ?? "";
    const speech = (params.get("SpeechResult") ?? "").trim();

    if (!toNumber || !fromNumber) return twimlResponse(sayAndHangup("Goodbye."));

    const auth = await authorizeTwilioRequest(req, params, toNumber, () =>
      twimlResponse(sayAndHangup("Sorry, this number is not in service. Goodbye."))
    );
    if (auth instanceof NextResponse) return auth;

    const turn = parseTurn(req.url);

    if (!speech) {
      return twimlResponse(
        turn >= MAX_VOICE_TURNS
          ? sayAndHangup("Goodbye.")
          : gatherSpeech("Sorry, I didn't catch that. Could you say that again?", turn + 1)
      );
    }

    const { result } = await processInbound({
      userId: auth.user_id,
      channel: "voice",
      fromNumber,
      text: speech,
    });

    if (turn >= MAX_VOICE_TURNS) {
      return twimlResponse(sayAndHangup(`${result.reply} Goodbye.`));
    }
    return twimlResponse(gatherSpeech(result.reply, turn + 1));
  } catch (err) {
    console.error("[voice] turn error:", err);
    return twimlResponse(sayAndHangup("Sorry, something went wrong. Goodbye."));
  }
}
