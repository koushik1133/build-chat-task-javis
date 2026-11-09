import { z } from "zod";

/**
 * Line items and totals shared by quotes and invoices.
 *
 * All amounts are minor units (integer). `tax_rate_bp` is basis points
 * (1000 = 10%). Rounding happens per line, half-up, so totals are stable
 * regardless of how the items are later regrouped.
 */

export const LineItemSchema = z.object({
  description: z.string().trim().min(1).max(500),
  qty: z.number().finite().min(0).max(1_000_000),
  unit_minor: z.number().int().min(0).max(1_000_000_000_000),
  tax_rate_bp: z.number().int().min(0).max(10_000).default(0),
  /** Catalogue tax rate (tax_rates.id). When it resolves, it wins over `tax_rate_bp`. */
  tax_rate_id: z.string().max(100).nullable().optional(),
  /** Several catalogue rates on one line (e.g. GST + compound PST). Supersedes `tax_rate_id`. */
  tax_rate_ids: z.array(z.string().max(100)).max(5).optional(),
  /** Optional pricebook link; lets inventory reserve/consume stock for this line. */
  product_id: z.string().max(100).optional(),
});
export type LineItem = z.infer<typeof LineItemSchema>;
export const LineItemsSchema = z.array(LineItemSchema).max(200);

export const CURRENCY_RE = /^[A-Z]{3}$/;
export const CurrencySchema = z.string().trim().toUpperCase().regex(CURRENCY_RE, "ISO 4217 code expected");

export interface Totals {
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
}

function roundHalfUp(n: number): number {
  return Math.floor(n + 0.5);
}

export function lineTotals(item: LineItem): Totals {
  const subtotal_minor = roundHalfUp(item.qty * item.unit_minor);
  const tax_minor = roundHalfUp((subtotal_minor * (item.tax_rate_bp ?? 0)) / 10_000);
  return { subtotal_minor, tax_minor, total_minor: subtotal_minor + tax_minor };
}

/** Pure: sum per-line rounded subtotals and taxes. Empty list → zeros. */
export function computeTotals(items: readonly LineItem[]): Totals {
  let subtotal_minor = 0;
  let tax_minor = 0;
  for (const it of items) {
    const t = lineTotals(it);
    subtotal_minor += t.subtotal_minor;
    tax_minor += t.tax_minor;
  }
  return { subtotal_minor, tax_minor, total_minor: subtotal_minor + tax_minor };
}

export function parseItems(raw: string | null | undefined): LineItem[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    const r = LineItemsSchema.safeParse(parsed);
    return r.success ? r.data : [];
  } catch {
    return [];
  }
}

/** Format minor units for humans (e.g. 123456 USD → "$1,234.56"). */
export function formatMoney(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}
