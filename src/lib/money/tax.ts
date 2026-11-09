/**
 * Tax engine (pure, client-safe: no DB, no clock).
 *
 * A line resolves to zero or more catalogue rates (`tax_rate_ids`, then
 * `tax_rate_id`, then the legacy inline `tax_rate_bp`). Non-compound rates
 * apply to the line net; compound rates apply to net + the non-compound taxes.
 *
 * `inclusive` means unit prices already contain tax: the net is backed out
 * with the combined effective rate. `rounding` picks whether each line's tax
 * is rounded (per_line, the default and the historic behaviour) or whether
 * unrounded amounts are summed per rate and rounded once (per_total).
 */

export type TaxKind = "vat" | "gst" | "sales" | "other";
export const TAX_KINDS: readonly TaxKind[] = ["vat", "gst", "sales", "other"];

export interface TaxRateLike {
  id: string;
  name: string;
  rate_bp: number;
  compound?: boolean | null;
  kind?: TaxKind | string | null;
}

export interface TaxableLine {
  qty: number;
  unit_minor: number;
  tax_rate_bp?: number | null;
  tax_rate_id?: string | null;
  tax_rate_ids?: string[] | null;
}

export type RoundingMode = "per_line" | "per_total";

export interface TaxOptions {
  inclusive?: boolean;
  rounding?: RoundingMode;
}

export interface TaxBreakdownRow {
  /** Catalogue id, or null for an inline basis-point rate. */
  rate_id: string | null;
  name: string;
  rate_bp: number;
  compound: boolean;
  taxable_minor: number;
  tax_minor: number;
}

export interface LineTax {
  /** Net (tax-exclusive) line amount, rounded. */
  net_minor: number;
  tax_minor: number;
  gross_minor: number;
  parts: Array<{ rate_id: string | null; name: string; rate_bp: number; compound: boolean; taxable: number; tax: number }>;
}

export interface TaxTotals {
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
  breakdown: TaxBreakdownRow[];
}

export function roundHalfUp(n: number): number {
  return Math.floor(n + 0.5);
}

/** Rates that apply to a line, in application order (non-compound first). */
export function resolveLineRates(line: TaxableLine, rates: readonly TaxRateLike[]): TaxRateLike[] {
  const byId = new Map(rates.map((r) => [r.id, r]));
  const ids = line.tax_rate_ids && line.tax_rate_ids.length > 0 ? line.tax_rate_ids : line.tax_rate_id ? [line.tax_rate_id] : [];
  const found: TaxRateLike[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (r && !found.includes(r)) found.push(r);
  }
  if (found.length > 0) {
    return [...found.filter((r) => !r.compound), ...found.filter((r) => Boolean(r.compound))];
  }
  const bp = Number(line.tax_rate_bp ?? 0);
  if (bp > 0) return [{ id: `bp:${bp}`, name: `Tax ${(bp / 100).toFixed(2).replace(/\.?0+$/, "")}%`, rate_bp: bp, compound: false }];
  return [];
}

/** Combined effective rate as a fraction (compound rates stack on the simple ones). */
export function effectiveRate(rates: readonly TaxRateLike[]): number {
  let simple = 0;
  for (const r of rates) if (!r.compound) simple += r.rate_bp / 10_000;
  let total = simple;
  for (const r of rates) if (r.compound) total += (1 + simple) * (r.rate_bp / 10_000);
  return total;
}

function isInline(r: TaxRateLike): boolean {
  return r.id.startsWith("bp:");
}

/**
 * Tax for one line. With `per_line` rounding every part is rounded; with
 * `per_total` the parts stay fractional so the caller can sum then round.
 */
export function computeLineTax(line: TaxableLine, rates: readonly TaxRateLike[], opts: TaxOptions = {}): LineTax {
  const applied = resolveLineRates(line, rates);
  const perLine = (opts.rounding ?? "per_line") === "per_line";
  const gross = Number(line.qty) * Number(line.unit_minor);
  const eff = effectiveRate(applied);
  const netRaw = opts.inclusive ? gross / (1 + eff) : gross;
  const net = roundHalfUp(netRaw);
  const base = perLine ? net : netRaw;

  const parts: LineTax["parts"] = [];
  let simpleTax = 0;
  for (const r of applied) {
    if (r.compound) continue;
    const tax = (base * r.rate_bp) / 10_000;
    const rounded = perLine ? roundHalfUp(tax) : tax;
    simpleTax += rounded;
    parts.push({ rate_id: isInline(r) ? null : r.id, name: r.name, rate_bp: r.rate_bp, compound: false, taxable: base, tax: rounded });
  }
  for (const r of applied) {
    if (!r.compound) continue;
    const taxable = base + simpleTax;
    const tax = (taxable * r.rate_bp) / 10_000;
    parts.push({ rate_id: isInline(r) ? null : r.id, name: r.name, rate_bp: r.rate_bp, compound: true, taxable, tax: perLine ? roundHalfUp(tax) : tax });
  }
  const taxSum = parts.reduce((s, p) => s + p.tax, 0);
  const tax_minor = perLine ? taxSum : roundHalfUp(taxSum);
  return { net_minor: net, tax_minor, gross_minor: net + tax_minor, parts };
}

/** Totals + breakdown by rate for a document. Empty list → zeros. */
export function computeTotals(items: readonly TaxableLine[], rates: readonly TaxRateLike[], opts: TaxOptions = {}): TaxTotals {
  const perLine = (opts.rounding ?? "per_line") === "per_line";
  const groups = new Map<string, { row: TaxBreakdownRow; taxable: number; tax: number }>();
  let subtotal = 0;
  for (const it of items) {
    const lt = computeLineTax(it, rates, opts);
    subtotal += lt.net_minor;
    for (const p of lt.parts) {
      const key = `${p.rate_id ?? "bp"}:${p.rate_bp}:${p.compound ? 1 : 0}`;
      const g = groups.get(key) ?? {
        row: { rate_id: p.rate_id, name: p.name, rate_bp: p.rate_bp, compound: p.compound, taxable_minor: 0, tax_minor: 0 },
        taxable: 0,
        tax: 0,
      };
      g.taxable += p.taxable;
      g.tax += p.tax;
      groups.set(key, g);
    }
  }
  const breakdown: TaxBreakdownRow[] = [];
  let tax = 0;
  for (const g of groups.values()) {
    const taxMinor = perLine ? g.tax : roundHalfUp(g.tax);
    breakdown.push({ ...g.row, taxable_minor: roundHalfUp(g.taxable), tax_minor: taxMinor });
    tax += taxMinor;
  }
  breakdown.sort((a, b) => Number(a.compound) - Number(b.compound) || a.rate_bp - b.rate_bp || a.name.localeCompare(b.name));
  return { subtotal_minor: subtotal, tax_minor: tax, total_minor: subtotal + tax, breakdown };
}

export function parseBreakdown(raw: string | null | undefined): TaxBreakdownRow[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object")
      .map((x) => ({
        rate_id: typeof x.rate_id === "string" ? x.rate_id : null,
        name: String(x.name ?? "Tax"),
        rate_bp: Number(x.rate_bp ?? 0),
        compound: Boolean(x.compound),
        taxable_minor: Number(x.taxable_minor ?? 0),
        tax_minor: Number(x.tax_minor ?? 0),
      }));
  } catch {
    return [];
  }
}

/** Human label for a rate: "GST 10%". */
export function rateLabel(r: Pick<TaxRateLike, "name" | "rate_bp">): string {
  return `${r.name} ${(r.rate_bp / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}
