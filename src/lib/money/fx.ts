import { randomUUID } from "crypto";
import { z } from "zod";
import { query } from "@/lib/dsql";
import { tableExists } from "@/lib/table-exists";
import { CurrencySchema } from "./items";

/**
 * Manual FX rates (per org) and a pure converter. Rates are stored as decimal
 * strings so no float ever hits the database; `rate` means 1 base = rate quote.
 */

export interface FxRateDTO {
  id: string;
  base: string;
  quote: string;
  rate: string;
  as_of: string;
}

export interface FxRateLike {
  base: string;
  quote: string;
  rate: string | number;
  as_of?: string | null;
}

export const FxRateInputSchema = z
  .object({
    base: CurrencySchema,
    quote: CurrencySchema,
    rate: z
      .union([z.number().positive().finite().max(1e12), z.string().trim().max(32).regex(/^\d{1,15}(\.\d{1,10})?$/)])
      .refine((v) => Number(v) > 0, { message: "rate must be greater than zero" }),
    as_of: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type FxRateInput = z.infer<typeof FxRateInputSchema>;

/**
 * Pure: convert minor units between currencies using the newest direct rate,
 * its inverse, or a USD-free two-hop via any shared pivot. Returns null when
 * no path exists. Same currency → identity. Rounds half-up.
 */
export function convertMinor(amountMinor: number, from: string, to: string, rates: readonly FxRateLike[]): number | null {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  if (f === t) return amountMinor;
  const factor = fxFactor(f, t, rates);
  if (factor === null) return null;
  return Math.floor(amountMinor * factor + 0.5);
}

function newest(rates: readonly FxRateLike[], base: string, quote: string): number | null {
  let best: FxRateLike | null = null;
  for (const r of rates) {
    if (r.base.toUpperCase() !== base || r.quote.toUpperCase() !== quote) continue;
    if (!best || new Date(r.as_of ?? 0).getTime() > new Date(best.as_of ?? 0).getTime()) best = r;
  }
  if (!best) return null;
  const n = Number(best.rate);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Multiplier taking `from` to `to`, or null. */
export function fxFactor(from: string, to: string, rates: readonly FxRateLike[]): number | null {
  const direct = newest(rates, from, to);
  if (direct !== null) return direct;
  const inverse = newest(rates, to, from);
  if (inverse !== null) return 1 / inverse;
  // Two hops through a pivot that both sides have a rate with.
  const pivots = new Set<string>();
  for (const r of rates) {
    pivots.add(r.base.toUpperCase());
    pivots.add(r.quote.toUpperCase());
  }
  for (const p of pivots) {
    if (p === from || p === to) continue;
    const a = fxDirectOrInverse(from, p, rates);
    const b = fxDirectOrInverse(p, to, rates);
    if (a !== null && b !== null) return a * b;
  }
  return null;
}

function fxDirectOrInverse(from: string, to: string, rates: readonly FxRateLike[]): number | null {
  const d = newest(rates, from, to);
  if (d !== null) return d;
  const i = newest(rates, to, from);
  return i !== null ? 1 / i : null;
}

export async function listFxRates(dataId: string): Promise<FxRateDTO[]> {
  if (!(await tableExists("fx_rates"))) return [];
  const rows = await query<{ id: string; base: string; quote: string; rate: string; as_of: Date | string }>(
    `SELECT id, base, quote, rate, as_of FROM fx_rates WHERE user_id = $1 ORDER BY base, quote, as_of DESC LIMIT 500`,
    [dataId]
  );
  return rows.map((r) => ({ id: r.id, base: r.base, quote: r.quote, rate: String(r.rate), as_of: r.as_of instanceof Date ? r.as_of.toISOString() : String(r.as_of) }));
}

export async function upsertFxRate(dataId: string, input: FxRateInput): Promise<FxRateDTO> {
  const base = input.base.toUpperCase();
  const quote = input.quote.toUpperCase();
  if (base === quote) throw new Error("Base and quote currencies must differ");
  const rate = typeof input.rate === "number" ? input.rate.toFixed(10).replace(/\.?0+$/, "") : input.rate;
  const asOf = input.as_of ?? new Date().toISOString();
  const id = randomUUID();
  await query(`INSERT INTO fx_rates (id, user_id, base, quote, rate, as_of) VALUES ($1, $2, $3, $4, $5, $6)`, [id, dataId, base, quote, rate, asOf]);
  return { id, base, quote, rate, as_of: asOf };
}

export async function deleteFxRate(dataId: string, id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(`DELETE FROM fx_rates WHERE id = $1 AND user_id = $2 RETURNING id`, [id, dataId]);
  return rows.length > 0;
}
