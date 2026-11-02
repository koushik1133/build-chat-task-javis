/**
 * Quote pricing suggestions — pure math, client-safe (no DB imports).
 *
 * For each line item on a quote, find past quote lines that describe the same
 * thing, split their unit prices into bands, and measure the win rate per band
 * (accepted vs declined/expired). The suggested range is the band with the
 * best expected value (price × win rate); the current price gets the win
 * probability of the band it falls into.
 */

export interface PricingItem {
  description: string;
  qty: number;
  unit_minor: number;
}

export interface PricingHistoryQuote {
  id: string;
  status: string;
  items: PricingItem[];
  created_at?: string;
}

export interface PriceBand {
  min_minor: number;
  max_minor: number;
  won: number;
  lost: number;
  winRate: number;
}

export interface ItemSuggestion {
  description: string;
  current_unit_minor: number;
  /** Decided (won or lost) historical lines that matched. */
  matches: number;
  basis: "history" | "insufficient";
  bands: PriceBand[];
  suggested_min_minor: number | null;
  suggested_max_minor: number | null;
  suggested_unit_minor: number | null;
  /** Win probability at the current price (band win rate, else overall). */
  expectedWinProbability: number;
  /** Win probability at the suggested price. */
  suggestedWinProbability: number | null;
  /** Expected line value at the suggested price vs current (qty × price × p). */
  expectedValueDelta_minor: number;
  note: string;
}

export interface PricingSuggestion {
  generatedAt: string;
  items: ItemSuggestion[];
  overall: { quotes: number; won: number; lost: number; winRate: number };
}

const STOP = new Set(["the", "and", "for", "with", "per", "hour", "hours", "hr", "day", "days", "unit", "units", "each", "service", "services", "fee", "of", "to", "in", "on", "a", "an"]);

export function tokens(desc: string): Set<string> {
  return new Set(
    desc
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !STOP.has(t))
  );
}

/** Jaccard similarity on content tokens; containment counts as a match for short descriptions. */
export function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return a.trim().toLowerCase() === b.trim().toLowerCase() ? 1 : 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  const jaccard = inter / union;
  const containment = inter / Math.min(ta.size, tb.size);
  return Math.max(jaccard, containment >= 1 ? 0.75 : 0);
}

export function outcome(status: string): "won" | "lost" | null {
  if (status === "accepted") return "won";
  if (status === "declined" || status === "expired") return "lost";
  return null;
}

function quantileBands(samples: Array<{ price: number; won: boolean }>, maxBands: number): PriceBand[] {
  const sorted = [...samples].sort((a, b) => a.price - b.price);
  const n = sorted.length;
  const bandCount = Math.max(1, Math.min(maxBands, Math.floor(n / 2)));
  const bands: PriceBand[] = [];
  for (let i = 0; i < bandCount; i++) {
    const from = Math.floor((i * n) / bandCount);
    const to = i === bandCount - 1 ? n : Math.floor(((i + 1) * n) / bandCount);
    const slice = sorted.slice(from, to);
    if (slice.length === 0) continue;
    const won = slice.filter((s) => s.won).length;
    const lost = slice.length - won;
    bands.push({ min_minor: slice[0].price, max_minor: slice[slice.length - 1].price, won, lost, winRate: slice.length ? won / slice.length : 0 });
  }
  // Merge bands with identical ranges (many samples at one price).
  const merged: PriceBand[] = [];
  for (const b of bands) {
    const last = merged[merged.length - 1];
    if (last && last.max_minor >= b.min_minor && last.min_minor === b.min_minor && last.max_minor === b.max_minor) {
      last.won += b.won;
      last.lost += b.lost;
      last.winRate = (last.won + last.lost) ? last.won / (last.won + last.lost) : 0;
    } else merged.push({ ...b });
  }
  return merged;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export function pricingSuggestion(
  items: PricingItem[],
  history: PricingHistoryQuote[],
  opts: { bands?: number; minSimilarity?: number; now?: Date } = {}
): PricingSuggestion {
  const maxBands = Math.min(Math.max(opts.bands ?? 4, 1), 8);
  const minSim = opts.minSimilarity ?? 0.5;
  const now = opts.now ?? new Date();

  let won = 0;
  let lost = 0;
  const decided = history.filter((q) => outcome(q.status) !== null);
  for (const q of decided) {
    if (outcome(q.status) === "won") won++;
    else lost++;
  }
  const overallRate = won + lost ? won / (won + lost) : 0;

  const out: ItemSuggestion[] = items.map((item) => {
    const current = Math.round(Number(item.unit_minor) || 0);
    const qty = Number(item.qty) || 1;
    const samples: Array<{ price: number; won: boolean }> = [];
    for (const q of decided) {
      const res = outcome(q.status);
      if (!res) continue;
      for (const h of q.items) {
        if (similarity(item.description, h.description) < minSim) continue;
        const price = Math.round(Number(h.unit_minor) || 0);
        if (price <= 0) continue;
        samples.push({ price, won: res === "won" });
      }
    }

    if (samples.length < 2) {
      return {
        description: item.description,
        current_unit_minor: current,
        matches: samples.length,
        basis: "insufficient",
        bands: [],
        suggested_min_minor: null,
        suggested_max_minor: null,
        suggested_unit_minor: null,
        expectedWinProbability: overallRate,
        suggestedWinProbability: null,
        expectedValueDelta_minor: 0,
        note: samples.length === 0 ? "No decided quotes with a matching line yet; using the overall win rate." : "Only one matching line in history; need at least two to form a price band.",
      };
    }

    const bands = quantileBands(samples, maxBands);
    const bandFor = (price: number): PriceBand | null => {
      const hit = bands.find((b) => price >= b.min_minor && price <= b.max_minor);
      if (hit) return hit;
      // Nearest band by distance to its range.
      let best: PriceBand | null = null;
      let bestD = Number.POSITIVE_INFINITY;
      for (const b of bands) {
        const d = price < b.min_minor ? b.min_minor - price : price - b.max_minor;
        if (d < bestD) {
          bestD = d;
          best = b;
        }
      }
      return best;
    };
    const currentBand = bandFor(current);
    const pCurrent = currentBand ? currentBand.winRate : overallRate;

    // Best band by expected value; ties → higher win rate. Bands need ≥2 samples.
    let best: PriceBand | null = null;
    let bestEv = -1;
    for (const b of bands) {
      if (b.won + b.lost < 2) continue;
      const mid = (b.min_minor + b.max_minor) / 2;
      const ev = mid * b.winRate;
      if (ev > bestEv || (ev === bestEv && best && b.winRate > best.winRate)) {
        bestEv = ev;
        best = b;
      }
    }
    if (!best) best = bands[0];
    const wonPrices = samples.filter((s) => s.won && s.price >= best!.min_minor && s.price <= best!.max_minor).map((s) => s.price);
    const suggested = median(wonPrices) ?? Math.round((best.min_minor + best.max_minor) / 2);
    const evDelta = Math.round(qty * (suggested * best.winRate - current * pCurrent));

    let note: string;
    if (current >= best.min_minor && current <= best.max_minor) note = `Current price sits in the best-performing band (${Math.round(best.winRate * 100)}% win rate over ${best.won + best.lost} lines).`;
    else if (current > best.max_minor) note = `Current price is above the band that wins most often; lowering toward the suggestion raises the win probability from ${Math.round(pCurrent * 100)}% to ${Math.round(best.winRate * 100)}%.`;
    else note = `Current price is below the best band; history suggests you can charge more without losing many deals.`;

    return {
      description: item.description,
      current_unit_minor: current,
      matches: samples.length,
      basis: "history",
      bands,
      suggested_min_minor: best.min_minor,
      suggested_max_minor: best.max_minor,
      suggested_unit_minor: suggested,
      expectedWinProbability: Math.round(pCurrent * 1000) / 1000,
      suggestedWinProbability: Math.round(best.winRate * 1000) / 1000,
      expectedValueDelta_minor: evDelta,
      note,
    };
  });

  return { generatedAt: now.toISOString(), items: out, overall: { quotes: decided.length, won, lost, winRate: Math.round(overallRate * 1000) / 1000 } };
}
