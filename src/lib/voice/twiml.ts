/**
 * Pure TwiML + script helpers for outbound voice campaigns.
 * Everything interpolated into XML is escaped; no DB, no env.
 */

export const DEFAULT_VOICE = "Polly.Joanna";
export const VOICES = ["Polly.Joanna", "Polly.Matthew", "Polly.Amy", "Polly.Brian", "Polly.Aditi", "alice", "man", "woman"] as const;

export const CAMPAIGN_WEBHOOK_PATH = "/api/voice/campaigns/webhook";

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

export interface MergeFields {
  first_name?: string | null;
  full_name?: string | null;
  company?: string | null;
  [key: string]: string | null | undefined;
}

/** Replace `{{field}}` placeholders; unknown fields become empty, never the literal braces. */
export function mergeScript(script: string, fields: MergeFields): string {
  return script
    .replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) => (fields[key] ?? "").toString().trim())
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .trim();
}

/** First word of a full name, for `{{first_name}}`. */
export function firstNameOf(fullName: string | null | undefined): string {
  return (fullName ?? "").trim().split(/\s+/)[0] ?? "";
}

/** Query-string safe webhook URL for a target + step. */
export function webhookUrl(base: string, targetId: string, kind: "twiml" | "gather" | "status"): string {
  const url = new URL(CAMPAIGN_WEBHOOK_PATH, base);
  url.searchParams.set("target", targetId);
  url.searchParams.set("kind", kind);
  return url.toString();
}

/**
 * Script read aloud, then a one-digit Gather ("press 1 if interested, 2 to opt out").
 * The Gather action posts back to the campaign webhook with the digit.
 */
export function buildCampaignTwiml(opts: { script: string; voice: string; gatherAction: string; repeatPrompt?: boolean }): string {
  const voice = escapeXml(opts.voice || DEFAULT_VOICE);
  const say = `<Say voice="${voice}">${escapeXml(opts.script)}</Say>`;
  const prompt = `<Say voice="${voice}">Press 1 if you are interested and someone will follow up. Press 2 if you would rather not be called again.</Say>`;
  return wrap(
    `${say}` +
      `<Gather numDigits="1" timeout="6" action="${escapeXml(opts.gatherAction)}" method="POST">${prompt}</Gather>` +
      // Reached only when the callee presses nothing.
      `<Say voice="${voice}">Thank you, goodbye.</Say><Hangup/>`
  );
}

export type GatherOutcome = "interested" | "opted_out" | "no_input";

export function interpretDigits(digits: string | null | undefined): GatherOutcome {
  const d = (digits ?? "").trim();
  if (d === "1") return "interested";
  if (d === "2") return "opted_out";
  return "no_input";
}

/** Closing message after a key press. */
export function buildGatherResultTwiml(outcome: GatherOutcome, voice: string): string {
  const v = escapeXml(voice || DEFAULT_VOICE);
  const text =
    outcome === "interested"
      ? "Great, thank you. Someone from our team will be in touch shortly. Goodbye."
      : outcome === "opted_out"
        ? "Understood. We have removed you from our call list. Goodbye."
        : "Thank you, goodbye.";
  return wrap(`<Say voice="${v}">${escapeXml(text)}</Say><Hangup/>`);
}

export function buildHangupTwiml(message?: string, voice?: string): string {
  const v = escapeXml(voice || DEFAULT_VOICE);
  return wrap(message ? `<Say voice="${v}">${escapeXml(message)}</Say><Hangup/>` : `<Hangup/>`);
}
