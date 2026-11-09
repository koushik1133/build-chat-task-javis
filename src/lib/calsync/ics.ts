/**
 * RFC 5545 calendar feed builder. Pure: no I/O. All times are UTC so no
 * VTIMEZONE block is needed.
 */

export interface IcsEvent {
  /** Stable identifier (a booking id): the UID is derived from it so re-fetching never duplicates. */
  id: string;
  summary: string;
  description?: string | null;
  startsAt: Date | string;
  endsAt: Date | string;
  status?: "confirmed" | "cancelled";
  updatedAt?: Date | string | null;
}

/** Escape TEXT values (backslash, semicolon, comma, newline). */
export function escapeIcsText(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/g, " ") // control chars cannot be smuggled into a content line
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** UTC basic format: 20261110T150000Z. */
export function icsDate(d: Date | string): string {
  const t = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(t.getTime())) throw new Error("invalid date");
  return t.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Fold a content line at 75 octets (UTF-8 aware); continuation lines start with one space. */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let cur = "";
  let curBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (curBytes + b > limit) {
      parts.push(cur);
      cur = "";
      curBytes = 0;
      limit = 74; // continuation lines lose one octet to the leading space
    }
    cur += ch;
    curBytes += b;
  }
  if (cur) parts.push(cur);
  return parts.join("\r\n ");
}

export function icsUid(id: string, domain = "kernelhub.app"): string {
  return `booking-${id}@${domain}`;
}

export function buildIcs(events: IcsEvent[], opts: { name: string; now?: Date; domain?: string }): string {
  const now = opts.now ?? new Date();
  const lines: string[] = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//KernelHub//Calendar Feed//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", `X-WR-CALNAME:${escapeIcsText(opts.name)}`];
  for (const e of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${icsUid(e.id, opts.domain)}`);
    lines.push(`DTSTAMP:${icsDate(e.updatedAt ?? now)}`);
    lines.push(`DTSTART:${icsDate(e.startsAt)}`);
    lines.push(`DTEND:${icsDate(e.endsAt)}`);
    lines.push(`SUMMARY:${escapeIcsText(e.summary)}`);
    if (e.description) lines.push(`DESCRIPTION:${escapeIcsText(e.description)}`);
    lines.push(`STATUS:${e.status === "cancelled" ? "CANCELLED" : "CONFIRMED"}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/** Titles show the customer's first name only. */
export function firstName(full: string | null | undefined): string {
  const f = (full ?? "").trim().split(/\s+/)[0] ?? "";
  return f.slice(0, 40);
}

export function bookingSummary(name: string | null | undefined): string {
  const f = firstName(name);
  return f ? `Appointment: ${f}` : "Appointment";
}
