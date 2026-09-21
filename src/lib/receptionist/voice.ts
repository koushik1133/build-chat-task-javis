import { NextResponse } from "next/server";

/**
 * TwiML helpers for the Twilio Voice receptionist.
 *
 * Every string interpolated into TwiML is XML-escaped here so caller speech
 * (which Twilio transcribes and posts back to us) can never break out of a
 * `<Say>` element.
 */

export const MAX_VOICE_TURNS = 6;
export const VOICE_TURN_PATH = "/api/integrations/voice/turn";

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function wrap(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}

/** `<Say>` + hang up — used for unknown numbers and the end of a call. */
export function sayAndHangup(message: string): string {
  return wrap(`<Say>${escapeXml(message)}</Say><Hangup/>`);
}

/** `<Gather input="speech">` around a prompt, posting the transcript to `/turn`. */
export function gatherSpeech(prompt: string, nextTurn: number): string {
  const action = `${VOICE_TURN_PATH}?turn=${Math.max(0, Math.floor(nextTurn))}`;
  return wrap(
    `<Gather input="speech" action="${escapeXml(action)}" method="POST" speechTimeout="auto">` +
      `<Say>${escapeXml(prompt)}</Say>` +
      `</Gather>` +
      // Reached only if the caller says nothing.
      `<Say>I didn't catch that. Goodbye.</Say><Hangup/>`
  );
}

/** Opening greeting for a new call. */
export function greeting(businessName: string): string {
  return `Hi, you've reached ${businessName}. How can I help?`;
}

export function twimlResponse(xml: string, status = 200): NextResponse {
  return new NextResponse(xml, { status, headers: { "Content-Type": "text/xml" } });
}

/** Parse the `turn` query param defensively. */
export function parseTurn(url: string): number {
  const raw = new URL(url).searchParams.get("turn");
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}
