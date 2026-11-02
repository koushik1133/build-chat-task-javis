import { query } from "@/lib/dsql";
import { timeValueMinor } from "./time";

/**
 * Job costing: revenue (paid invoices) against costs (expenses + time at rate +
 * product cost of consumed stock), per job and in total.
 *
 * A "job" is whatever work costs were logged against: `ref_kind:ref_id`
 * (invoice, quote, booking, record, ...). Revenue always lands on the invoice
 * job; costs logged against the invoice's quote are folded into it through
 * the alias map so a quote → invoice flow reports as one job.
 */

export type CostKind = "revenue" | "expense" | "time" | "stock";

export interface CostRow {
  job_kind: string;
  job_id: string;
  kind: CostKind;
  amount_minor: number;
  currency: string;
}

export interface JobCost {
  job_kind: string;
  job_id: string;
  /** "invoice:abc" — stable key for the UI. */
  key: string;
  label: string;
  currency: string;
  revenue_minor: number;
  expense_minor: number;
  time_minor: number;
  stock_minor: number;
  cost_minor: number;
  margin_minor: number;
  /** margin / revenue × 100, null when there is no revenue. */
  margin_pct: number | null;
}

export interface JobCostingTotals {
  revenue_minor: number;
  expense_minor: number;
  time_minor: number;
  stock_minor: number;
  cost_minor: number;
  margin_minor: number;
  margin_pct: number | null;
  /** Currencies seen; more than one means the totals mix currencies. */
  currencies: string[];
}

export interface JobCostingReport {
  jobs: JobCost[];
  totals: JobCostingTotals;
}

export const UNASSIGNED_KEY = "none:";

export function jobKey(kind: string | null | undefined, id: string | null | undefined): string {
  return kind && id ? `${kind}:${id}` : UNASSIGNED_KEY;
}

function pct(margin: number, revenue: number): number | null {
  if (revenue <= 0) return null;
  return Math.round((margin / revenue) * 10_000) / 100;
}

/**
 * Pure: fold cost rows into per-job figures and grand totals.
 * `aliases` maps a job key onto another (e.g. "quote:Q1" → "invoice:I1").
 * `labels` supplies display names per job key; unknown jobs fall back to the key.
 */
export function aggregateJobCosting(
  rows: readonly CostRow[],
  opts: { aliases?: ReadonlyMap<string, string>; labels?: ReadonlyMap<string, string> } = {}
): JobCostingReport {
  const jobs = new Map<string, JobCost>();
  const currencies = new Set<string>();

  for (const r of rows) {
    let key = jobKey(r.job_kind, r.job_id);
    const seen = new Set<string>();
    while (opts.aliases?.has(key) && !seen.has(key)) {
      seen.add(key);
      key = opts.aliases.get(key)!;
    }
    const [job_kind, ...rest] = key.split(":");
    const job_id = rest.join(":");
    let j = jobs.get(key);
    if (!j) {
      j = {
        job_kind,
        job_id,
        key,
        label: opts.labels?.get(key) ?? (key === UNASSIGNED_KEY ? "Unassigned" : key),
        currency: r.currency,
        revenue_minor: 0,
        expense_minor: 0,
        time_minor: 0,
        stock_minor: 0,
        cost_minor: 0,
        margin_minor: 0,
        margin_pct: null,
      };
      jobs.set(key, j);
    }
    const amt = Math.round(Number(r.amount_minor) || 0);
    currencies.add(r.currency);
    if (r.kind === "revenue") j.revenue_minor += amt;
    else if (r.kind === "expense") j.expense_minor += amt;
    else if (r.kind === "time") j.time_minor += amt;
    else if (r.kind === "stock") j.stock_minor += amt;
  }

  const totals: JobCostingTotals = {
    revenue_minor: 0, expense_minor: 0, time_minor: 0, stock_minor: 0, cost_minor: 0, margin_minor: 0, margin_pct: null,
    currencies: [...currencies].sort(),
  };
  const list = [...jobs.values()];
  for (const j of list) {
    j.cost_minor = j.expense_minor + j.time_minor + j.stock_minor;
    j.margin_minor = j.revenue_minor - j.cost_minor;
    j.margin_pct = pct(j.margin_minor, j.revenue_minor);
    totals.revenue_minor += j.revenue_minor;
    totals.expense_minor += j.expense_minor;
    totals.time_minor += j.time_minor;
    totals.stock_minor += j.stock_minor;
  }
  totals.cost_minor = totals.expense_minor + totals.time_minor + totals.stock_minor;
  totals.margin_minor = totals.revenue_minor - totals.cost_minor;
  totals.margin_pct = pct(totals.margin_minor, totals.revenue_minor);

  // Biggest revenue first, then biggest cost; unassigned last.
  list.sort((a, b) => {
    if (a.key === UNASSIGNED_KEY) return 1;
    if (b.key === UNASSIGNED_KEY) return -1;
    return b.revenue_minor - a.revenue_minor || b.cost_minor - a.cost_minor || a.label.localeCompare(b.label);
  });
  return { jobs: list, totals };
}

// ── Data access ───────────────────────────────────────────────────────────────

interface InvoiceLite { id: string; number: string; quote_id: string | null; currency: string; paid_minor: string | number; status: string; paid_at: string | null }
interface QuoteLite { id: string; number: string }

function rangeClause(col: string, params: unknown[], from?: string | null, to?: string | null): string {
  let sql = "";
  if (from) {
    params.push(from);
    sql += ` AND ${col} >= $${params.length}`;
  }
  if (to) {
    params.push(to);
    sql += ` AND ${col} <= $${params.length}`;
  }
  return sql;
}

async function labelsFor(dataId: string, keys: Iterable<string>): Promise<Map<string, string>> {
  const invoiceIds: string[] = [];
  const quoteIds: string[] = [];
  for (const k of keys) {
    const [kind, ...rest] = k.split(":");
    const id = rest.join(":");
    if (kind === "invoice") invoiceIds.push(id);
    else if (kind === "quote") quoteIds.push(id);
  }
  const labels = new Map<string, string>();
  if (invoiceIds.length) {
    const rows = await query<{ id: string; number: string; contact_name: string | null }>(
      `SELECT i.id, i.number, c.full_name AS contact_name FROM invoices i LEFT JOIN crm_contacts c ON c.id = i.contact_id
        WHERE i.user_id = $1 AND i.id = ANY($2::text[])`,
      [dataId, invoiceIds]
    );
    for (const r of rows) labels.set(`invoice:${r.id}`, r.contact_name ? `${r.number} · ${r.contact_name}` : r.number);
  }
  if (quoteIds.length) {
    const rows = await query<QuoteLite>(`SELECT id, number FROM quotes WHERE user_id = $1 AND id = ANY($2::text[])`, [dataId, quoteIds]);
    for (const r of rows) labels.set(`quote:${r.id}`, r.number);
  }
  return labels;
}

async function collectRows(dataId: string, where: { from?: string | null; to?: string | null; invoiceIds?: string[]; refs?: Array<{ kind: string; id: string }> }): Promise<CostRow[]> {
  const rows: CostRow[] = [];

  // Revenue: paid invoices.
  {
    const params: unknown[] = [dataId];
    let sql = `SELECT id, number, quote_id, currency, paid_minor, status, paid_at FROM invoices WHERE user_id = $1 AND status = 'paid' AND paid_minor > 0`;
    if (where.invoiceIds) {
      params.push(where.invoiceIds);
      sql += ` AND id = ANY($${params.length}::text[])`;
    }
    sql += rangeClause("paid_at", params, where.from, where.to);
    const inv = await query<InvoiceLite>(sql, params);
    for (const i of inv) rows.push({ job_kind: "invoice", job_id: i.id, kind: "revenue", amount_minor: Number(i.paid_minor), currency: i.currency });
  }

  const refFilter = (params: unknown[]): string => {
    if (!where.refs) return "";
    if (where.refs.length === 0) return " AND FALSE";
    const parts = where.refs.map((r) => {
      params.push(r.kind, r.id);
      return `(ref_kind = $${params.length - 1} AND ref_id = $${params.length})`;
    });
    return ` AND (${parts.join(" OR ")})`;
  };

  // Expenses (amount + tax: it all left the bank).
  {
    const params: unknown[] = [dataId];
    let sql = `SELECT ref_kind, ref_id, amount_minor, tax_minor, currency FROM expenses WHERE user_id = $1`;
    sql += rangeClause("spent_at", params, where.from, where.to);
    sql += refFilter(params);
    const ex = await query<{ ref_kind: string | null; ref_id: string | null; amount_minor: string; tax_minor: string; currency: string }>(sql, params);
    for (const e of ex) rows.push({ job_kind: e.ref_kind ?? "none", job_id: e.ref_id ?? "", kind: "expense", amount_minor: Number(e.amount_minor) + Number(e.tax_minor), currency: e.currency });
  }

  // Time at rate (completed entries only).
  {
    const params: unknown[] = [dataId];
    let sql = `SELECT ref_kind, ref_id, minutes, rate_minor, currency FROM time_entries WHERE user_id = $1 AND ended_at IS NOT NULL`;
    sql += rangeClause("started_at", params, where.from, where.to);
    sql += refFilter(params);
    const te = await query<{ ref_kind: string | null; ref_id: string | null; minutes: number; rate_minor: string; currency: string }>(sql, params);
    for (const t of te) rows.push({ job_kind: t.ref_kind ?? "none", job_id: t.ref_id ?? "", kind: "time", amount_minor: timeValueMinor(t.minutes, Number(t.rate_minor)), currency: t.currency });
  }

  // Consumed stock at product cost.
  {
    const params: unknown[] = [dataId];
    let sql = `SELECT m.ref_kind, m.ref_id, m.qty, p.cost_minor, p.currency FROM stock_movements m JOIN products p ON p.id = m.product_id
                WHERE m.user_id = $1 AND m.kind = 'consume'`;
    sql += rangeClause("m.created_at", params, where.from, where.to);
    if (where.refs) {
      if (where.refs.length === 0) sql += " AND FALSE";
      else {
        const parts = where.refs.map((r) => {
          params.push(r.kind, r.id);
          return `(m.ref_kind = $${params.length - 1} AND m.ref_id = $${params.length})`;
        });
        sql += ` AND (${parts.join(" OR ")})`;
      }
    }
    const sm = await query<{ ref_kind: string | null; ref_id: string | null; qty: number; cost_minor: string; currency: string }>(sql, params);
    for (const m of sm) rows.push({ job_kind: m.ref_kind ?? "none", job_id: m.ref_id ?? "", kind: "stock", amount_minor: Number(m.qty) * Number(m.cost_minor), currency: m.currency });
  }
  return rows;
}

/** quote:<id> → invoice:<id> for every invoice that came from a quote. */
async function quoteAliases(dataId: string, invoiceIds?: string[]): Promise<Map<string, string>> {
  const params: unknown[] = [dataId];
  let sql = `SELECT id, quote_id FROM invoices WHERE user_id = $1 AND quote_id IS NOT NULL AND status <> 'void'`;
  if (invoiceIds) {
    params.push(invoiceIds);
    sql += ` AND id = ANY($${params.length}::text[])`;
  }
  const rows = await query<{ id: string; quote_id: string }>(sql, params);
  const m = new Map<string, string>();
  for (const r of rows) if (!m.has(`quote:${r.quote_id}`)) m.set(`quote:${r.quote_id}`, `invoice:${r.id}`);
  return m;
}

/** All jobs with activity in the date range (paid_at / spent_at / started_at / consumed_at). */
export async function jobCostingSummary(dataId: string, range: { from?: string | null; to?: string | null } = {}): Promise<JobCostingReport> {
  const [rows, aliases] = await Promise.all([collectRows(dataId, range), quoteAliases(dataId)]);
  const keys = new Set<string>();
  for (const r of rows) {
    let k = jobKey(r.job_kind, r.job_id);
    if (aliases.has(k)) k = aliases.get(k)!;
    keys.add(k);
  }
  const labels = await labelsFor(dataId, keys);
  return aggregateJobCosting(rows, { aliases, labels });
}

/** One job (by ref). For a quote, its invoices are included; for an invoice, its quote's costs are included. */
export async function jobCosting(dataId: string, job: { refKind: string; refId: string }): Promise<JobCostingReport> {
  const refs: Array<{ kind: string; id: string }> = [{ kind: job.refKind, id: job.refId }];
  let invoiceIds: string[] = [];
  if (job.refKind === "invoice") {
    invoiceIds = [job.refId];
    const inv = await query<{ quote_id: string | null }>(`SELECT quote_id FROM invoices WHERE id = $1 AND user_id = $2`, [job.refId, dataId]);
    if (inv[0]?.quote_id) refs.push({ kind: "quote", id: inv[0].quote_id });
  } else if (job.refKind === "quote") {
    const inv = await query<{ id: string }>(`SELECT id FROM invoices WHERE quote_id = $1 AND user_id = $2 AND status <> 'void'`, [job.refId, dataId]);
    invoiceIds = inv.map((i) => i.id);
    for (const id of invoiceIds) refs.push({ kind: "invoice", id });
  }
  const rows = await collectRows(dataId, { invoiceIds, refs });
  const aliases = new Map<string, string>();
  const target = jobKey(job.refKind, job.refId);
  for (const r of refs) {
    const k = jobKey(r.kind, r.id);
    if (k !== target) aliases.set(k, target);
  }
  const labels = await labelsFor(dataId, [target]);
  return aggregateJobCosting(rows, { aliases, labels });
}
