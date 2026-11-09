import { createHash, randomUUID } from "crypto";
import { query, queryOne, isUndefinedColumn } from "@/lib/dsql";
import { tableExists } from "@/lib/table-exists";
import { resolveShipping } from "./index";
import { applyMarkup, evaluateRules, type RuleInput, type ShippingRule, type RuleKind } from "./rules";
import { parseJson, ShippingError, type Address, type CarrierRate } from "./types";

/** Shipping rules (CRUD) and the checkout quote: rules first, live carrier rates for carrier_calculated rules. */

export const DEFAULT_UNIT_WEIGHT_GRAMS = 500;

interface RuleRow {
  id: string;
  name: string;
  kind: RuleKind;
  config: string;
  countries: string;
  active: boolean;
  sort: number;
}

const toRule = (r: RuleRow): ShippingRule => ({ id: r.id, name: r.name, kind: r.kind, config: parseJson<Record<string, unknown>>(r.config, {}), countries: parseJson<string[]>(r.countries, []), active: Boolean(r.active), sort: Number(r.sort) });

export async function listRules(dataId: string): Promise<ShippingRule[]> {
  if (!(await tableExists("shipping_rules"))) return [];
  return (await query<RuleRow>(`SELECT id, name, kind, config, countries, active, sort FROM shipping_rules WHERE user_id = $1 ORDER BY sort ASC, created_at ASC LIMIT 200`, [dataId])).map(toRule);
}

export async function createRule(dataId: string, input: RuleInput): Promise<ShippingRule> {
  const id = randomUUID();
  await query(`INSERT INTO shipping_rules (id, user_id, name, kind, config, countries, active, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, dataId, input.name, input.kind, JSON.stringify(input.config), JSON.stringify(input.countries), input.active, input.sort]);
  return { id, name: input.name, kind: input.kind, config: input.config, countries: input.countries, active: input.active, sort: input.sort };
}

export async function updateRule(dataId: string, id: string, input: RuleInput): Promise<ShippingRule> {
  const rows = await query<{ id: string }>(`UPDATE shipping_rules SET name=$3, kind=$4, config=$5, countries=$6, active=$7, sort=$8 WHERE id=$1 AND user_id=$2 RETURNING id`, [id, dataId, input.name, input.kind, JSON.stringify(input.config), JSON.stringify(input.countries), input.active, input.sort]);
  if (rows.length === 0) throw new ShippingError("not_found", "Rule not found", 404);
  return { id, name: input.name, kind: input.kind, config: input.config, countries: input.countries, active: input.active, sort: input.sort };
}

export async function deleteRule(dataId: string, id: string): Promise<void> {
  await query(`DELETE FROM shipping_rules WHERE id = $1 AND user_id = $2`, [id, dataId]);
}

/* ── cart facts ────────────────────────────────────────────────────────── */

export interface QuoteItem {
  product_id: string;
  qty: number;
}
export interface CartFacts {
  subtotal_minor: number;
  weight_grams: number;
}

interface ProdRow {
  id: string;
  unit_price_minor: string | number;
  weight_grams?: number | null;
}

export async function loadProductFacts(dataId: string, ids: string[]): Promise<Map<string, { price: number; weight: number | null }>> {
  const out = new Map<string, { price: number; weight: number | null }>();
  if (ids.length === 0 || !(await tableExists("products"))) return out;
  let list: ProdRow[];
  try {
    list = await query<ProdRow>(`SELECT id, unit_price_minor, weight_grams FROM products WHERE user_id = $1 AND id = ANY($2::text[])`, [dataId, ids]);
  } catch (err) {
    if (!isUndefinedColumn(err)) throw err;
    list = await query<ProdRow>(`SELECT id, unit_price_minor FROM products WHERE user_id = $1 AND id = ANY($2::text[])`, [dataId, ids]);
  }
  for (const r of list) out.set(r.id, { price: Number(r.unit_price_minor), weight: r.weight_grams ?? null });
  return out;
}

export async function cartFacts(dataId: string, items: QuoteItem[]): Promise<CartFacts> {
  const facts = await loadProductFacts(dataId, items.map((i) => i.product_id));
  let subtotal = 0;
  let weight = 0;
  for (const it of items) {
    const f = facts.get(it.product_id);
    if (!f) continue;
    subtotal += f.price * it.qty;
    weight += (f.weight ?? DEFAULT_UNIT_WEIGHT_GRAMS) * it.qty;
  }
  return { subtotal_minor: subtotal, weight_grams: Math.max(1, weight) };
}

/* ── quote ─────────────────────────────────────────────────────────────── */

export interface ShippingOption {
  id: string;
  label: string;
  price_minor: number;
  currency: string;
  days_min: number | null;
  days_max: number | null;
  source: "rule" | "carrier";
  carrier: string | null;
  service: string | null;
  rate_id: string | null;
}

export interface ShippingQuote {
  options: ShippingOption[];
  weight_grams: number;
  subtotal_minor: number;
  /** False when the org has no active rules: callers keep the legacy flat/pickup behaviour. */
  rules_active: boolean;
}

const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 500;
const cache = new Map<string, { at: number; value: ShippingQuote }>();

/** Cache key always starts with the data id so one tenant can never read another's entry. */
export function quoteCacheKey(dataId: string, items: QuoteItem[], address: Pick<Address, "country" | "postal_code" | "region" | "city">, rulesFingerprint: string): string {
  const norm = [...items].sort((a, b) => a.product_id.localeCompare(b.product_id)).map((i) => `${i.product_id}x${i.qty}`).join(",");
  const h = createHash("sha256").update(`${norm}|${address.country.toLowerCase()}|${(address.postal_code ?? "").toLowerCase()}|${(address.region ?? "").toLowerCase()}|${address.city.toLowerCase()}|${rulesFingerprint}`).digest("hex").slice(0, 32);
  return `${dataId}:${h}`;
}

export function resetQuoteCache(): void {
  cache.clear();
}
export function quoteCacheKeys(): string[] {
  return [...cache.keys()];
}

export async function quoteShipping(dataId: string, input: { items: QuoteItem[]; address: Address; currency?: string; now?: Date }): Promise<ShippingQuote> {
  const rules = (await listRules(dataId)).filter((r) => r.active);
  const facts = await cartFacts(dataId, input.items);
  if (rules.length === 0) return { options: [], weight_grams: facts.weight_grams, subtotal_minor: facts.subtotal_minor, rules_active: false };
  const key = quoteCacheKey(dataId, input.items, input.address, createHash("sha256").update(JSON.stringify(rules)).digest("hex").slice(0, 12) + `:${facts.subtotal_minor}`);
  const nowMs = (input.now ?? new Date()).getTime();
  const hit = cache.get(key);
  if (hit && nowMs - hit.at < TTL_MS) return hit.value;

  const currency = (input.currency ?? "USD").toUpperCase();
  const base = evaluateRules(rules, { country: input.address.country, subtotal_minor: facts.subtotal_minor, weight_grams: facts.weight_grams });
  const options: ShippingOption[] = [];
  let carrierRates: CarrierRate[] | null = null;
  for (const o of base) {
    if (!o.needs_carrier) {
      options.push({ id: o.id, label: o.label, price_minor: o.price_minor, currency, days_min: o.days_min, days_max: o.days_max, source: "rule", carrier: null, service: null, rate_id: null });
      continue;
    }
    if (carrierRates === null) carrierRates = await liveRates(dataId, input.address, facts.weight_grams, currency);
    const rule = rules.find((r) => r.id === o.rule_id);
    const only = Array.isArray(rule?.config.services) ? (rule?.config.services as string[]).map((s) => s.toLowerCase()) : [];
    for (const r of carrierRates) {
      if (only.length > 0 && !only.includes(r.service.toLowerCase())) continue;
      options.push({ id: `carrier:${r.provider}:${r.id}`, label: r.service_label, price_minor: applyMarkup(r.amount_minor, rule?.config ?? {}), currency, days_min: r.days_min, days_max: r.days_max, source: "carrier", carrier: r.carrier, service: r.service, rate_id: r.id });
    }
  }
  options.sort((a, b) => a.price_minor - b.price_minor || a.label.localeCompare(b.label));
  const value: ShippingQuote = { options, weight_grams: facts.weight_grams, subtotal_minor: facts.subtotal_minor, rules_active: true };
  if (cache.size >= MAX_ENTRIES) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  cache.set(key, { at: nowMs, value });
  return value;
}

async function liveRates(dataId: string, to: Address, weightGrams: number, currency: string): Promise<CarrierRate[]> {
  try {
    const setup = await resolveShipping(dataId);
    const from: Address = setup.ship_from ?? { line1: "Origin", city: "Origin", country: to.country };
    return await setup.provider.rates({ from, to, parcel: { ...(setup.default_package ?? {}), weight_grams: weightGrams }, currency }, setup.creds);
  } catch (err) {
    console.error("[shipping] carrier rates unavailable:", err instanceof Error ? err.message : err);
    return [];
  }
}

/** The stored quote for an order's chosen method (set at checkout). */
export interface OrderShippingQuote {
  option_id: string;
  label: string;
  price_minor: number;
  carrier: string | null;
  service: string | null;
  rate_id: string | null;
  days_min: number | null;
  days_max: number | null;
}

export function toOrderQuote(o: ShippingOption): OrderShippingQuote {
  return { option_id: o.id, label: o.label, price_minor: o.price_minor, carrier: o.carrier, service: o.service, rate_id: o.rate_id, days_min: o.days_min, days_max: o.days_max };
}

export async function anyActiveRules(dataId: string): Promise<boolean> {
  if (!(await tableExists("shipping_rules"))) return false;
  const r = await queryOne<{ n: string | number }>(`SELECT COUNT(*) AS n FROM shipping_rules WHERE user_id = $1 AND active = TRUE`, [dataId]);
  return Number(r?.n ?? 0) > 0;
}
