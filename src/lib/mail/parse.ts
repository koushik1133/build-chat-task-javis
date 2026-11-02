import type { NormalizedMessage } from "./types";

/**
 * Pure parsing helpers for the mail lane: Gmail payload decoding, address
 * extraction, thread keys and the mail → unified-inbox turn mapping.
 * No DB, no env — safe to import from tests and client code.
 */

export function decodeBase64Url(data: string | null | undefined): string {
  if (!data) return "";
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  try {
    return Buffer.from(b64 + pad, "base64").toString("utf8");
  } catch {
    return "";
  }
}

/** "Jane Doe <jane@x.com>" → "jane@x.com"; lower-cased, trimmed. */
export function extractAddress(raw: string | null | undefined): string {
  if (!raw) return "";
  const m = raw.match(/<([^>]+)>/);
  const addr = (m ? m[1] : raw).trim().toLowerCase();
  return addr.replace(/^mailto:/, "");
}

/** Display name portion of "Jane Doe <jane@x.com>", or null. */
export function extractName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>/);
  const name = m ? m[1].trim() : "";
  return name || null;
}

/** Split a To/Cc header into individual lower-cased addresses. */
export function splitAddresses(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((p) => extractAddress(p))
    .filter(Boolean);
}

/** Strip Re:/Fwd: prefixes so replies fold into one thread key. */
export function normalizeSubject(subject: string | null | undefined): string {
  return (subject ?? "")
    .replace(/^\s*((re|fwd?|aw|wg)\s*:\s*)+/i, "")
    .trim()
    .toLowerCase();
}

/**
 * Stable thread key for a message. Providers that expose a thread id use it;
 * otherwise the normalised subject + counterpart address stands in.
 */
export function threadKeyFor(accountId: string, msg: Pick<NormalizedMessage, "threadId" | "subject" | "from" | "to" | "direction">): string {
  if (msg.threadId) return `email:${accountId}:${msg.threadId}`;
  const counterpart = msg.direction === "in" ? extractAddress(msg.from) : extractAddress(msg.to[0] ?? "");
  return `email:${accountId}:${counterpart}:${normalizeSubject(msg.subject) || "(no subject)"}`;
}

/** Very small HTML → text fallback for providers that only give HTML. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Drop quoted history ("On … wrote:" and "> " lines) so the inbox shows the new text only. */
export function stripQuotedReply(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (/^On .+wrote:\s*$/.test(line.trim())) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line.trim())) break;
    if (/^From: .+$/i.test(line.trim()) && out.length > 0 && out[out.length - 1].trim() === "") break;
    if (line.trim().startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

// ── Gmail ────────────────────────────────────────────────────────────────────

export interface GmailHeader {
  name: string;
  value: string;
}
export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}
export interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

function header(headers: GmailHeader[] | undefined, name: string): string {
  const h = headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

function collectBodies(part: GmailPart | undefined, acc: { text: string[]; html: string[] }): void {
  if (!part) return;
  const mime = (part.mimeType ?? "").toLowerCase();
  if (part.body?.data && !part.filename) {
    if (mime === "text/plain") acc.text.push(decodeBase64Url(part.body.data));
    else if (mime === "text/html") acc.html.push(decodeBase64Url(part.body.data));
  }
  for (const p of part.parts ?? []) collectBodies(p, acc);
}

/** Gmail `users.messages.get?format=full` → NormalizedMessage. */
export function parseGmailMessage(msg: GmailMessage, accountEmail: string): NormalizedMessage {
  const headers = msg.payload?.headers ?? [];
  const bodies = { text: [] as string[], html: [] as string[] };
  collectBodies(msg.payload, bodies);
  const bodyHtml = bodies.html.join("\n") || null;
  const bodyText = bodies.text.join("\n").trim() || htmlToText(bodyHtml);
  const from = extractAddress(header(headers, "From"));
  const labels = msg.labelIds ?? [];
  const direction: "in" | "out" = labels.includes("SENT") || (from && from === accountEmail.toLowerCase()) ? "out" : "in";
  const ms = Number(msg.internalDate);
  const receivedAt = Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : new Date().toISOString();
  return {
    providerMessageId: msg.id,
    threadId: msg.threadId ?? null,
    direction,
    from,
    fromName: extractName(header(headers, "From")),
    to: [...splitAddresses(header(headers, "To")), ...splitAddresses(header(headers, "Cc"))],
    subject: header(headers, "Subject"),
    snippet: (msg.snippet ?? bodyText).slice(0, 300),
    bodyText,
    bodyHtml,
    receivedAt,
    isRead: !labels.includes("UNREAD"),
    labels,
  };
}

/** Minimal RFC 2822 message, base64url-encoded for Gmail `messages.send`. */
export function buildRawEmail(input: { from: string; to: string[]; subject: string; text: string; inReplyTo?: string | null }): string {
  const lines = [
    `From: ${input.from}`,
    `To: ${input.to.join(", ")}`,
    `Subject: ${encodeHeader(input.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
  ];
  if (input.inReplyTo) {
    lines.push(`In-Reply-To: ${input.inReplyTo}`);
    lines.push(`References: ${input.inReplyTo}`);
  }
  const raw = `${lines.join("\r\n")}\r\n\r\n${input.text}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}

/** RFC 2047 encode a header value when it is not plain ASCII. */
export function encodeHeader(value: string): string {
  // Header injection guard first: a CR/LF can never start a new header line.
  const clean = value.replace(/[\r\n]+/g, " ");
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

// ── Outlook / Graph ──────────────────────────────────────────────────────────

export interface GraphRecipient {
  emailAddress?: { address?: string; name?: string };
}
export interface GraphMessage {
  id: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  receivedDateTime?: string;
  sentDateTime?: string;
  isRead?: boolean;
  isDraft?: boolean;
  from?: GraphRecipient;
  sender?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  body?: { contentType?: string; content?: string };
  categories?: string[];
  "@removed"?: { reason?: string };
}

export function parseGraphMessage(msg: GraphMessage, accountEmail: string): NormalizedMessage {
  const from = (msg.from?.emailAddress?.address ?? msg.sender?.emailAddress?.address ?? "").toLowerCase();
  const isHtml = (msg.body?.contentType ?? "").toLowerCase() === "html";
  const bodyHtml = isHtml ? (msg.body?.content ?? null) : null;
  const bodyText = isHtml ? htmlToText(bodyHtml) : (msg.body?.content ?? "").trim();
  const recipients = [...(msg.toRecipients ?? []), ...(msg.ccRecipients ?? [])]
    .map((r) => (r.emailAddress?.address ?? "").toLowerCase())
    .filter(Boolean);
  return {
    providerMessageId: msg.id,
    threadId: msg.conversationId ?? null,
    direction: from && from === accountEmail.toLowerCase() ? "out" : "in",
    from,
    fromName: msg.from?.emailAddress?.name ?? msg.sender?.emailAddress?.name ?? null,
    to: recipients,
    subject: msg.subject ?? "",
    snippet: (msg.bodyPreview ?? bodyText).slice(0, 300),
    bodyText,
    bodyHtml,
    receivedAt: msg.receivedDateTime ?? msg.sentDateTime ?? new Date().toISOString(),
    isRead: msg.isRead !== false,
    labels: msg.categories ?? [],
  };
}

// ── Unified inbox mapping ────────────────────────────────────────────────────

export interface InboxTurn {
  role: "user" | "assistant";
  content: string;
  ts: string;
}

/**
 * A mail message as one turn in a messaging_conversations thread. Inbound mail
 * is the customer ("user"); mail we sent is "assistant". The subject leads the
 * first line so the thread still reads well when the body is short.
 */
export function mailToTurn(msg: Pick<NormalizedMessage, "direction" | "subject" | "bodyText" | "receivedAt">, opts: { includeSubject?: boolean } = {}): InboxTurn {
  const body = stripQuotedReply(msg.bodyText || "").slice(0, 6000);
  const subject = msg.subject?.trim();
  const content = opts.includeSubject !== false && subject ? `${subject}\n\n${body}`.trim() : body || subject || "(empty message)";
  return { role: msg.direction === "in" ? "user" : "assistant", content, ts: msg.receivedAt };
}

/** Reply subject for a thread: adds one "Re: " at most. */
export function replySubject(subject: string | null | undefined): string {
  const s = (subject ?? "").trim();
  if (!s) return "Re: (no subject)";
  return /^re\s*:/i.test(s) ? s : `Re: ${s}`;
}
