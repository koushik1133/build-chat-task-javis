/** Client-safe inbox helpers: snooze arithmetic, filters, categories. */

export type SnoozeKind = "1h" | "tomorrow";

export const INBOX_CATEGORIES = ["approvals", "helpdesk", "billing", "bookings", "agents", "team", "reports", "system"] as const;
export const CATEGORY_LABEL: Record<string, string> = {
  approvals: "Approvals",
  helpdesk: "Helpdesk",
  billing: "Billing",
  bookings: "Bookings",
  agents: "Agents",
  team: "Team",
  reports: "Reports",
  system: "System",
  general: "General",
};

/**
 * When a snoozed item returns. `1h` = now + 60 min. `tomorrow` = 09:00 local
 * time on the next local day, where `tzOffsetMinutes` is the browser's
 * `Date#getTimezoneOffset()` (minutes UTC is ahead of local; 0 = UTC).
 */
export function snoozeUntil(kind: SnoozeKind, now: Date, tzOffsetMinutes = 0): Date {
  if (kind === "1h") return new Date(now.getTime() + 60 * 60 * 1000);
  const offset = Math.max(-840, Math.min(840, Math.trunc(tzOffsetMinutes) || 0));
  const local = new Date(now.getTime() - offset * 60_000); // UTC fields now read as local wall-clock
  const target = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1, 9, 0, 0);
  return new Date(target + offset * 60_000);
}

export interface InboxItem {
  id: string;
  title: string;
  body: string | null;
  category: string;
  read: boolean;
  created_at: string;
  snoozed_until: string | null;
  href: string | null;
}

/** An item is hidden while its snooze is in the future. */
export function isSnoozed(item: Pick<InboxItem, "snoozed_until">, now: Date): boolean {
  return Boolean(item.snoozed_until) && new Date(item.snoozed_until as string).getTime() > now.getTime();
}

export function filterInbox(items: InboxItem[], f: { unread?: boolean; category?: string | null }, now = new Date()): InboxItem[] {
  return items.filter((i) => {
    if (isSnoozed(i, now)) return false;
    if (f.unread && i.read) return false;
    if (f.category && i.category !== f.category) return false;
    return true;
  });
}

export function categoryOf(data: Record<string, unknown> | null): string {
  const c = data?.category;
  return typeof c === "string" && c ? c : "general";
}

/** Same-origin link carried in notification data (`href`/`url`), else null. */
export function linkOf(data: Record<string, unknown> | null): string | null {
  const v = data?.href ?? data?.url ?? data?.link;
  return typeof v === "string" && v.startsWith("/") && !v.startsWith("//") && !v.includes("\\") && !/[\u0000-\u001f\u007f]/.test(v) ? v : null;
}
