/**
 * Output safety for AI-authored text that is about to reach a customer, plus
 * log redaction for stored prompts.
 */

export interface GuardResult {
  ok: boolean;
  reasons: string[];
}

const KEY_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bgsk_[A-Za-z0-9]{16,}/,
  /\bAIza[0-9A-Za-z_-]{20,}/,
  /\bkh_[A-Za-z0-9_]{12,}/,
  /\bwhsec_[A-Za-z0-9]{12,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
];

const LEAK_MARKERS: RegExp[] = [
  /untrusted content rules/i,
  /<<<UNTRUSTED/i,
  /my (system )?prompt (is|says|reads)/i,
  /you are the ai receptionist for/i,
  /\bsystem prompt\b.*:/i,
  /available tools:/i,
];

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
const INTERNAL_PATH = /(?:\/api\/(?:v1\/|cron\/|internal\/)|\/\(app\)\/|\blocalhost:\d+|\b127\.0\.0\.1|\.internal\b)/i;
const MERGE = /\{\{\s*[\w.]+\s*\}\}/;

export const MAX_CUSTOMER_REPLY_CHARS = 1200;

/** Run all checks; `ok: false` means the reply must not be auto-sent. */
export function guardCustomerReply(text: string, opts: { maxChars?: number } = {}): GuardResult {
  const reasons: string[] = [];
  if (KEY_PATTERNS.some((r) => r.test(text))) reasons.push("contains a key-like secret");
  if (LEAK_MARKERS.some((r) => r.test(text))) reasons.push("looks like system-prompt leakage");
  if (UUID.test(text)) reasons.push("contains an internal id");
  if (INTERNAL_PATH.test(text)) reasons.push("contains an internal URL or route");
  if (MERGE.test(text)) reasons.push("has an unresolved {{merge}} field");
  if (text.length > (opts.maxChars ?? MAX_CUSTOMER_REPLY_CHARS)) reasons.push("is too long");
  if (!text.trim()) reasons.push("is empty");
  return { ok: reasons.length === 0, reasons };
}

/** Redact secrets and PII from text destined for logs / debug storage. */
export function redactForLog(text: string): string {
  return String(text ?? "")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "[jwt]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer [token]")
    .replace(/\b(?:sk-|gsk_|kh_|whsec_)[A-Za-z0-9_-]{12,}/g, "[key]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "[key]")
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, "[email]")
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "[card]")
    .replace(/(?<!\w)\+?\d[\d\s().-]{7,}\d/g, "[phone]");
}

/** Truncated, redacted preview suitable for persistent storage. */
export function promptPreview(text: string, max = 300): string {
  const r = redactForLog(text);
  return r.length > max ? `${r.slice(0, max)}…` : r;
}

/** Redact only the spans wrapped as untrusted content (keeps the rest for debugging). */
export function redactUntrustedSpans(text: string): string {
  return text.replace(/<<<UNTRUSTED:([\w.-]+):([0-9a-f]+)\n([\s\S]*?)\n\2>>>/g, (_m, label: string, nonce: string, body: string) =>
    `<<<UNTRUSTED:${label}:${nonce}\n${redactForLog(body)}\n${nonce}>>>`
  );
}
