/** Client-safe helpers for recent items and favourites (no DB). */

export const RECENT_CAP = 30;
export const FAVORITES_CAP = 50;

/** Same-origin path guard: stored hrefs must be app-relative. */
export function safeHref(href: unknown): string | null {
  if (typeof href !== "string") return null;
  const h = href.trim();
  // Browsers drop tabs/newlines inside URLs ("/\t/evil.com" becomes "//evil.com"), so control chars are rejected outright.
  if (!h.startsWith("/") || h.startsWith("//") || h.includes("\\") || /[\u0000-\u001f\u007f]/.test(h) || h.length > 500) return null;
  return h;
}

/** Ids to delete so only the `cap` most recently opened rows remain. */
export function idsToPrune<T extends { id: string; opened_at: string | Date }>(rows: T[], cap = RECENT_CAP): string[] {
  const sorted = [...rows].sort((a, b) => new Date(b.opened_at).getTime() - new Date(a.opened_at).getTime());
  return sorted.slice(cap).map((r) => r.id);
}

/** Uniqueness key of a favourite: entity favourites by (kind, entity), pages by href. */
export function favoriteKey(kind: string, entityId: string | null | undefined, href: string): string {
  return `${kind}:${entityId ?? href}`;
}
