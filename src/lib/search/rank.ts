/**
 * Pure search helpers (client-safe, no DB): query operators, ranking, typo
 * tolerant LIKE patterns and the final per-kind / total caps.
 */
import { escapeLike } from "@/lib/like";

export interface ParsedQuery {
  /** Free text left after operators were removed. */
  text: string;
  /** Kind filters from `kind:orders,tickets` (normalised to singular). */
  kinds: string[];
  /** Area/module filters from `in:billing`. */
  areas: string[];
}

export const PER_KIND = 5;
export const TOTAL_CAP = 40;

/** Singular form of a kind name ("orders" -> "order", "bills" -> "supplier_bill" alias handled by callers). */
export function normaliseKind(raw: string): string {
  const k = raw.toLowerCase().replace(/[^a-z_]/g, "");
  const alias: Record<string, string> = {
    bills: "bill", bill: "bill", supplierbills: "bill", pos: "purchase_order", po: "purchase_order",
    purchaseorders: "purchase_order", purchaseorder: "purchase_order", people: "staff", reports: "report",
    kb: "article", articles: "article", pages: "page", messages: "message", booking_types: "booking_type",
    bookingtypes: "booking_type", sequences: "sequence", audiences: "audience", campaigns: "campaign",
  };
  if (alias[k]) return alias[k];
  if (k.endsWith("ies")) return `${k.slice(0, -3)}y`;
  if (k.endsWith("s") && !k.endsWith("ss") && k !== "status") return k.slice(0, -1);
  return k;
}

/** Parse `kind:` and `in:` operators (only those two); every other token stays free text. */
export function parseSearchQuery(raw: string): ParsedQuery {
  const kinds: string[] = [];
  const areas: string[] = [];
  const rest: string[] = [];
  for (const tok of raw.trim().split(/\s+/)) {
    const m = /^(kind|in):(.+)$/i.exec(tok);
    if (!m) {
      if (tok) rest.push(tok);
      continue;
    }
    const values = m[2].split(",").map((v) => v.trim()).filter(Boolean);
    if (m[1].toLowerCase() === "kind") kinds.push(...values.map(normaliseKind));
    else areas.push(...values.map((v) => v.toLowerCase()));
  }
  return { text: rest.join(" "), kinds, areas };
}

/** Rank score: 4 exact, 3 prefix, 2 word-start, 1 substring, 0.5 typo-tolerant prefix, 0 none. */
export function matchScore(haystack: string, needle: string): number {
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase().trim();
  if (!n) return 0;
  if (h === n) return 4;
  if (h.startsWith(n)) return 3;
  if (new RegExp(`(^|[^a-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(h)) return 2;
  if (h.includes(n)) return 1;
  const stem = fuzzyStem(n);
  if (stem && h.includes(stem)) return 0.5;
  return 0;
}

/** Leading half of a longer query: survives a typo in the tail ("smiht" -> "smi"). */
export function fuzzyStem(q: string): string | null {
  const n = q.trim();
  if (n.length < 5) return null;
  return n.slice(0, Math.max(3, Math.ceil(n.length / 2)));
}

/** ILIKE patterns for a query: substring plus the typo-tolerant stem (all escaped). */
export function likePatterns(q: string): string[] {
  const n = q.trim();
  const out = [`%${escapeLike(n)}%`];
  const stem = fuzzyStem(n);
  if (stem) out.push(`%${escapeLike(stem)}%`);
  return out;
}

export interface Rankable {
  kind: string;
  id: string;
  title: string;
  subtitle: string | null;
  /** ISO timestamp used as the recency tiebreak. */
  at?: string | null;
}

/** Best score across title and subtitle (title weighs more). */
export function scoreItem(item: Rankable, needle: string): number {
  const t = matchScore(item.title, needle);
  const s = item.subtitle ? matchScore(item.subtitle, needle) * 0.8 : 0;
  return Math.max(t, s);
}

/** Sort by score desc then recency desc, stable. */
export function rankItems<T extends Rankable>(items: T[], needle: string): T[] {
  return items
    .map((item, i) => ({ item, i, score: scoreItem(item, needle), at: item.at ? Date.parse(item.at) || 0 : 0 }))
    .sort((a, b) => b.score - a.score || b.at - a.at || a.i - b.i)
    .map((x) => x.item);
}

/** Apply the per-kind limit then the overall cap, preserving order. */
export function capResults<T extends { kind: string }>(items: T[], perKind = PER_KIND, total = TOTAL_CAP): T[] {
  const counts = new Map<string, number>();
  const out: T[] = [];
  for (const it of items) {
    const n = counts.get(it.kind) ?? 0;
    if (n >= perKind) continue;
    counts.set(it.kind, n + 1);
    out.push(it);
    if (out.length >= total) break;
  }
  return out;
}
