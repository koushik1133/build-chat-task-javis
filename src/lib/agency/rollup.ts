import { query } from "@/lib/dsql";
import { tableExists } from "@/lib/table-exists";
import { listChildOrgs, type ChildOrgDTO } from "./orgs";

/**
 * Cross-workspace roll-up for an agency: one row per client workspace with
 * revenue (paid invoices), open quotes, bookings, open tickets and AI spend,
 * plus totals. Every figure is read with the child's data id, so nothing
 * here needs the caller to switch workspaces.
 */

export interface RollupRow {
  org: Pick<ChildOrgDTO, "id" | "name" | "slug" | "dataId" | "archived">;
  currency: string;
  revenue_minor: number;
  paid_invoices: number;
  open_quotes: number;
  open_quotes_minor: number;
  bookings: number;
  open_tickets: number;
  ai_cost_micros: number;
  ai_calls: number;
}

export interface RollupTotals {
  clients: number;
  revenue_minor: number;
  paid_invoices: number;
  open_quotes: number;
  open_quotes_minor: number;
  bookings: number;
  open_tickets: number;
  ai_cost_micros: number;
  ai_calls: number;
  currencies: string[];
}

export interface RollupReport {
  from: string;
  to: string;
  rows: RollupRow[];
  totals: RollupTotals;
}

interface RevenueRow { user_id: string; currency: string; revenue: string | number; n: string | number }
interface QuoteRow { user_id: string; n: string | number; total: string | number }
interface CountRow { user_id: string; n: string | number }
interface AiRow { user_id: string; cost: string | number; n: string | number }

/** Pure: fold the per-table aggregates into rows + totals. Exported for tests. */
export function aggregateRollup(
  orgs: Array<Pick<ChildOrgDTO, "id" | "name" | "slug" | "dataId" | "archived">>,
  agg: {
    revenue: RevenueRow[];
    quotes: QuoteRow[];
    bookings: CountRow[];
    tickets: CountRow[];
    ai: AiRow[];
  },
  range: { from: string; to: string }
): RollupReport {
  const byId = <T extends { user_id: string }>(rows: T[]) => new Map(rows.map((r) => [r.user_id, r]));
  const revenue = new Map<string, { currency: string; revenue: number; n: number }>();
  for (const r of agg.revenue) {
    // One currency per workspace is the norm; if several appear, keep the largest and note it.
    const cur = revenue.get(r.user_id);
    if (!cur || Number(r.revenue) > cur.revenue) revenue.set(r.user_id, { currency: r.currency, revenue: Number(r.revenue), n: Number(r.n) + (cur?.n ?? 0) });
    else cur.n += Number(r.n);
  }
  const quotes = byId(agg.quotes);
  const bookings = byId(agg.bookings);
  const tickets = byId(agg.tickets);
  const ai = byId(agg.ai);

  const rows: RollupRow[] = orgs.map((o) => {
    const rev = revenue.get(o.dataId);
    const q = quotes.get(o.dataId);
    const a = ai.get(o.dataId);
    return {
      org: { id: o.id, name: o.name, slug: o.slug, dataId: o.dataId, archived: o.archived },
      currency: rev?.currency ?? "USD",
      revenue_minor: rev?.revenue ?? 0,
      paid_invoices: rev?.n ?? 0,
      open_quotes: Number(q?.n ?? 0),
      open_quotes_minor: Number(q?.total ?? 0),
      bookings: Number(bookings.get(o.dataId)?.n ?? 0),
      open_tickets: Number(tickets.get(o.dataId)?.n ?? 0),
      ai_cost_micros: Number(a?.cost ?? 0),
      ai_calls: Number(a?.n ?? 0),
    };
  });
  rows.sort((x, y) => y.revenue_minor - x.revenue_minor || x.org.name.localeCompare(y.org.name));

  const totals: RollupTotals = {
    clients: rows.length,
    revenue_minor: 0, paid_invoices: 0, open_quotes: 0, open_quotes_minor: 0, bookings: 0, open_tickets: 0, ai_cost_micros: 0, ai_calls: 0,
    currencies: [],
  };
  const currencies = new Set<string>();
  for (const r of rows) {
    totals.revenue_minor += r.revenue_minor;
    totals.paid_invoices += r.paid_invoices;
    totals.open_quotes += r.open_quotes;
    totals.open_quotes_minor += r.open_quotes_minor;
    totals.bookings += r.bookings;
    totals.open_tickets += r.open_tickets;
    totals.ai_cost_micros += r.ai_cost_micros;
    totals.ai_calls += r.ai_calls;
    if (r.revenue_minor > 0 || r.open_quotes_minor > 0) currencies.add(r.currency);
  }
  totals.currencies = [...currencies].sort();
  return { from: range.from, to: range.to, rows, totals };
}

export async function rollup(parentDataId: string, range: { from: string; to: string }): Promise<RollupReport> {
  const orgs = await listChildOrgs(parentDataId);
  const ids = orgs.map((o) => o.dataId);
  if (ids.length === 0) return aggregateRollup([], { revenue: [], quotes: [], bookings: [], tickets: [], ai: [] }, range);

  const safe = async <T>(p: Promise<T[]>): Promise<T[]> =>
    p.catch((err) => {
      console.warn("[agency/rollup] aggregate failed:", err instanceof Error ? err.message : err);
      return [];
    });

  const [revenue, quotes, bookings, hasTickets, ai] = await Promise.all([
    safe(query<RevenueRow>(
      `SELECT user_id, currency, COALESCE(SUM(paid_minor), 0) AS revenue, COUNT(*) AS n
         FROM invoices
        WHERE user_id = ANY($1::text[]) AND status = 'paid' AND paid_at >= $2 AND paid_at <= $3
        GROUP BY user_id, currency`,
      [ids, range.from, range.to]
    )),
    safe(query<QuoteRow>(
      `SELECT user_id, COUNT(*) AS n, COALESCE(SUM(total_minor), 0) AS total
         FROM quotes WHERE user_id = ANY($1::text[]) AND status IN ('draft', 'sent', 'viewed')
        GROUP BY user_id`,
      [ids]
    )),
    safe(query<CountRow>(
      `SELECT user_id, COUNT(*) AS n FROM bookings
        WHERE user_id = ANY($1::text[]) AND status IN ('confirmed', 'completed') AND starts_at >= $2 AND starts_at <= $3
        GROUP BY user_id`,
      [ids, range.from, range.to]
    )),
    tableExists("tickets"),
    safe(query<AiRow>(
      `SELECT user_id, COALESCE(SUM(cost_micros), 0) AS cost, COUNT(*) AS n FROM ai_usage
        WHERE user_id = ANY($1::text[]) AND created_at >= $2 AND created_at <= $3
        GROUP BY user_id`,
      [ids, range.from, range.to]
    )),
  ]);
  const tickets = hasTickets
    ? await safe(query<CountRow>(
        `SELECT user_id, COUNT(*) AS n FROM tickets WHERE user_id = ANY($1::text[]) AND status IN ('open', 'pending') GROUP BY user_id`,
        [ids]
      ))
    : [];

  return aggregateRollup(orgs, { revenue, quotes, bookings, tickets, ai }, range);
}
