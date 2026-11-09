/**
 * Shipping rule engine and shipment/return state rules. Pure and client-safe
 * (the rules editor previews with the same code the server quotes with).
 */
import { z } from "zod";
import type { ShipmentStatus } from "./types";

export const RULE_KINDS = ["flat", "weight_tiers", "free_over", "carrier_calculated"] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

const Money = z.number().int().min(0).max(1_000_000_000);
const Days = z.number().int().min(0).max(120).optional();

export const FlatConfig = z.object({ price_minor: Money, label: z.string().trim().max(80).optional(), days_min: Days, days_max: Days }).strict();
export const WeightTiersConfig = z
  .object({
    tiers: z.array(z.object({ up_to_grams: z.number().int().min(1).max(70_000_000), price_minor: Money }).strict()).min(1).max(20),
    over_price_minor: Money.optional(),
    label: z.string().trim().max(80).optional(),
    days_min: Days,
    days_max: Days,
  })
  .strict();
export const FreeOverConfig = z.object({ threshold_minor: Money, label: z.string().trim().max(80).optional(), days_min: Days, days_max: Days }).strict();
export const CarrierConfig = z
  .object({ markup_pct: z.number().min(0).max(300).optional(), markup_flat_minor: Money.optional(), services: z.array(z.string().max(40)).max(10).optional(), label: z.string().trim().max(80).optional() })
  .strict();

export const CONFIG_SCHEMAS = { flat: FlatConfig, weight_tiers: WeightTiersConfig, free_over: FreeOverConfig, carrier_calculated: CarrierConfig } as const;

export const RuleInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(RULE_KINDS),
    config: z.record(z.unknown()),
    countries: z.array(z.string().trim().min(2).max(64)).max(300).default([]),
    active: z.boolean().default(true),
    sort: z.number().int().min(0).max(10_000).default(0),
  })
  .strict()
  .superRefine((v, ctx) => {
    const r = CONFIG_SCHEMAS[v.kind].safeParse(v.config);
    if (!r.success) ctx.addIssue({ code: "custom", path: ["config"], message: r.error.issues[0]?.message ?? "Invalid config" });
  });
export type RuleInput = z.infer<typeof RuleInputSchema>;

export interface ShippingRule {
  id: string;
  name: string;
  kind: RuleKind;
  config: Record<string, unknown>;
  countries: string[];
  active: boolean;
  sort: number;
}

export interface QuoteContext {
  country: string;
  subtotal_minor: number;
  weight_grams: number;
}

export interface RuleOption {
  id: string;
  rule_id: string;
  label: string;
  price_minor: number;
  days_min: number | null;
  days_max: number | null;
  /** carrier_calculated rules need live rates before they become options. */
  needs_carrier: boolean;
}

const ALIASES: Record<string, string> = {
  usa: "US", "u.s.": "US", "u.s.a.": "US", "united states": "US", "united states of america": "US", america: "US",
  uk: "GB", "u.k.": "GB", "united kingdom": "GB", "great britain": "GB", england: "GB", britain: "GB",
  india: "IN", canada: "CA", australia: "AU", germany: "DE", france: "FR", spain: "ES", italy: "IT", netherlands: "NL", ireland: "IE", mexico: "MX", japan: "JP", singapore: "SG", "united arab emirates": "AE", uae: "AE",
};

/** Normalise a country name or code to an upper-case key (ISO-2 when we know the name). */
export function normalizeCountry(raw: string | null | undefined): string {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return "";
  return ALIASES[s] ?? s.toUpperCase();
}

export function countryMatches(rule: Pick<ShippingRule, "countries">, country: string): boolean {
  if (rule.countries.length === 0) return true;
  const c = normalizeCountry(country);
  return rule.countries.some((x) => normalizeCountry(x) === c);
}

const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const optDays = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Price for a weight tier table; null when no tier applies and there is no over-price. */
export function tierPrice(tiers: Array<{ up_to_grams: number; price_minor: number }>, grams: number, over?: number): number | null {
  const sorted = [...tiers].sort((a, b) => a.up_to_grams - b.up_to_grams);
  for (const t of sorted) if (grams <= t.up_to_grams) return t.price_minor;
  return over ?? null;
}

/**
 * Evaluate active rules for a cart. Non-carrier rules resolve to concrete
 * options; carrier_calculated rules resolve to placeholders (`needs_carrier`)
 * that quote.ts replaces with live rates.
 */
export function evaluateRules(rules: readonly ShippingRule[], ctx: QuoteContext): RuleOption[] {
  const out: RuleOption[] = [];
  const ordered = [...rules].filter((r) => r.active).sort((a, b) => a.sort - b.sort);
  for (const r of ordered) {
    if (!countryMatches(r, ctx.country)) continue;
    const c = r.config;
    const base = { id: `rule:${r.id}`, rule_id: r.id, days_min: optDays(c.days_min), days_max: optDays(c.days_max), needs_carrier: false };
    const label = typeof c.label === "string" && c.label ? c.label : r.name;
    if (r.kind === "flat") out.push({ ...base, label, price_minor: Math.max(0, Math.trunc(num(c.price_minor))) });
    else if (r.kind === "weight_tiers") {
      const tiers = Array.isArray(c.tiers) ? (c.tiers as Array<{ up_to_grams: number; price_minor: number }>) : [];
      const p = tierPrice(tiers, ctx.weight_grams, typeof c.over_price_minor === "number" ? c.over_price_minor : undefined);
      if (p !== null) out.push({ ...base, label, price_minor: Math.max(0, Math.trunc(p)) });
    } else if (r.kind === "free_over") {
      if (ctx.subtotal_minor >= num(c.threshold_minor, Number.MAX_SAFE_INTEGER)) out.push({ ...base, label: typeof c.label === "string" && c.label ? c.label : "Free shipping", price_minor: 0 });
    } else if (r.kind === "carrier_calculated") out.push({ ...base, label, price_minor: 0, needs_carrier: true });
  }
  return out;
}

/** Carrier rate plus the rule's markup. */
export function applyMarkup(amount_minor: number, cfg: Record<string, unknown>): number {
  const pct = num(cfg.markup_pct);
  const flat = num(cfg.markup_flat_minor);
  return Math.max(0, Math.round(amount_minor * (1 + pct / 100)) + Math.trunc(flat));
}

/* ── shipment status precedence ─────────────────────────────────────────── */

const RANK: Record<ShipmentStatus, number> = { draft: 0, label_purchased: 1, in_transit: 2, out_for_delivery: 3, exception: 3, returned: 4, delivered: 5, void: 6 };

/**
 * The status a shipment should have after a carrier reports `incoming`.
 * Never regresses (delivered stays delivered; in_transit never undoes
 * out_for_delivery); an exception can be recovered from; void is terminal.
 */
export function nextShipmentStatus(current: ShipmentStatus, incoming: ShipmentStatus): ShipmentStatus {
  if (current === "void" || current === "delivered" || current === "returned") return current;
  if (incoming === "void" || incoming === "draft") return current;
  if (current === "exception") return incoming === "label_purchased" ? current : incoming;
  if (incoming === "exception") return current === "draft" || current === "label_purchased" || current === "in_transit" || current === "out_for_delivery" ? "exception" : current;
  return RANK[incoming] > RANK[current] ? incoming : current;
}

/* ── returns ─────────────────────────────────────────────────────────────── */

export const DEFAULT_RETURN_WINDOW_DAYS = 30;

/** Is a return still allowed? The window runs from delivery (or fulfilment/payment when untracked). */
export function withinReturnWindow(anchorIso: string | null | undefined, windowDays: number, now: Date = new Date()): { ok: boolean; deadline: string | null; days_left: number } {
  if (!anchorIso) return { ok: false, deadline: null, days_left: 0 };
  const start = new Date(anchorIso).getTime();
  if (!Number.isFinite(start)) return { ok: false, deadline: null, days_left: 0 };
  const deadline = start + Math.max(0, windowDays) * 86_400_000;
  const left = Math.ceil((deadline - now.getTime()) / 86_400_000);
  return { ok: now.getTime() <= deadline, deadline: new Date(deadline).toISOString(), days_left: Math.max(0, left) };
}

/** Refund can never exceed what the order actually collected minus what was already refunded. */
export function cappedRefund(requested: number, paid_minor: number, refunded_minor: number): number {
  const room = Math.max(0, paid_minor - refunded_minor);
  if (!Number.isFinite(requested) || requested <= 0) return 0;
  return Math.min(Math.trunc(requested), room);
}

/** Value of returned lines at the order's own unit prices (tax excluded), capped at each line's ordered quantity. */
export function returnLinesValue(orderItems: Array<{ product_id?: string | null; description: string; qty: number; unit_minor: number }>, lines: Array<{ product_id?: string | null; description?: string; qty: number }>): number {
  let total = 0;
  for (const l of lines) {
    const match = orderItems.find((o) => (l.product_id && o.product_id === l.product_id) || (!l.product_id && l.description && o.description === l.description));
    if (!match) continue;
    total += Math.round(Math.min(l.qty, match.qty) * match.unit_minor);
  }
  return total;
}

/* ── Code 39 bars (drawn on labels) ─────────────────────────────────────── */

// Each symbol: 9 elements alternating bar/space (starting with a bar); 'w' = wide.
const C39: Record<string, string> = {
  "0": "nnnwwnwnn", "1": "wnnwnnnnw", "2": "nnwwnnnnw", "3": "wnwwnnnnn", "4": "nnnwwnnnw", "5": "wnnwwnnnn", "6": "nnwwwnnnn", "7": "nnnwnnwnw", "8": "wnnwnnwnn", "9": "nnwwnnwnn",
  A: "wnnnnwnnw", B: "nnwnnwnnw", C: "wnwnnwnnn", D: "nnnnwwnnw", E: "wnnnwwnnn", F: "nnwnwwnnn", G: "nnnnnwwnw", H: "wnnnnwwnn", I: "nnwnnwwnn", J: "nnnnwwwnn",
  K: "wnnnnnnww", L: "nnwnnnnww", M: "wnwnnnnwn", N: "nnnnwnnww", O: "wnnnwnnwn", P: "nnwnwnnwn", Q: "nnnnnnwww", R: "wnnnnnwwn", S: "nnwnnnwwn", T: "nnnnwnwwn",
  U: "wwnnnnnnw", V: "nwwnnnnnw", W: "wwwnnnnnn", X: "nwnnwnnnw", Y: "wwnnwnnnn", Z: "nwwnwnnnn", "-": "nwnnnnwnw", ".": "wwnnnnwnn", " ": "nwwnnnwnn", "*": "nwnnwnwnn",
};

/** Bars as {x, w} in module units for `*TEXT*` (narrow = 1, wide = 3, 1-module gap between symbols). Unknown characters become "-". */
export function code39Bars(text: string): { bars: Array<{ x: number; w: number }>; width: number } {
  const clean = `*${text.toUpperCase().replace(/[^0-9A-Z\-. ]/g, "-")}*`;
  const bars: Array<{ x: number; w: number }> = [];
  let x = 0;
  for (const ch of clean) {
    const pat = C39[ch];
    for (let i = 0; i < 9; i++) {
      const w = pat[i] === "w" ? 3 : 1;
      if (i % 2 === 0) bars.push({ x, w });
      x += w;
    }
    x += 1;
  }
  return { bars, width: x - 1 };
}
