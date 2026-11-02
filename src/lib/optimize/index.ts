import { query, queryOne } from "@/lib/dsql";
import { tableExists } from "@/lib/table-exists";
import { parseItems } from "@/lib/money/items";
import { meteredComplete } from "@/lib/llm/metering";
import { LlmNotConfiguredError } from "@/lib/llm/providers";
import { cashflowForecast, type CashflowForecast, type CashflowInputs, type CashflowOptions } from "./cashflow";
import { capacityPlan, type CapacityInputs, type CapacityOptions, type CapacityPlan } from "./capacity";
import { pricingSuggestion, type PricingHistoryQuote, type PricingItem, type PricingSuggestion } from "./pricing";

/**
 * Server side of the optimisation AI: load real rows for a workspace, run the
 * pure models, and (optionally) narrate the result with the metered LLM.
 */

export { cashflowForecast, capacityPlan, pricingSuggestion, LlmNotConfiguredError };
export type { CashflowForecast, CapacityPlan, PricingSuggestion, PricingItem };

const DAY_MS = 86_400_000;

// ── Loaders ─────────────────────────────────────────────────────────────────

export async function loadCashflowInputs(dataId: string, now = new Date()): Promise<CashflowInputs & { currency: string }> {
  const since = new Date(now.getTime() - 365 * DAY_MS).toISOString();
  const expenseSince = new Date(now.getTime() - 180 * DAY_MS).toISOString();
  const safe = async <T>(p: Promise<T[]>): Promise<T[]> => p.catch(() => []);

  const [invoices, hasExpenses, quotes, bookings] = await Promise.all([
    safe(query<{ id: string; number: string; contact_id: string | null; status: string; total_minor: string | number; paid_minor: string | number; due_at: string | null; sent_at: string | null; created_at: string; paid_at: string | null; currency: string }>(
      `SELECT id, number, contact_id, status, total_minor, paid_minor, due_at, sent_at, created_at, paid_at, currency
         FROM invoices WHERE user_id = $1 AND (status IN ('sent', 'partially_paid', 'overdue') OR (status = 'paid' AND paid_at >= $2))
        ORDER BY created_at DESC LIMIT 1000`,
      [dataId, since]
    )),
    tableExists("expenses"),
    safe(query<{ id: string; status: string; total_minor: string | number; valid_until: string | null; created_at: string; contact_id: string | null }>(
      `SELECT id, status, total_minor, valid_until, created_at, contact_id FROM quotes WHERE user_id = $1 AND status IN ('draft', 'sent', 'viewed') ORDER BY created_at DESC LIMIT 500`,
      [dataId]
    )),
    safe(query<{ id: string; status: string; starts_at: string; price_minor: string | number | null }>(
      `SELECT b.id, b.status, b.starts_at, t.price_minor FROM bookings b LEFT JOIN booking_types t ON t.id = b.booking_type_id
        WHERE b.user_id = $1 AND b.status = 'confirmed' AND b.starts_at >= $2 ORDER BY b.starts_at ASC LIMIT 1000`,
      [dataId, now.toISOString()]
    )),
  ]);
  const expenses = hasExpenses
    ? await safe(query<{ id: string; vendor: string | null; category: string | null; amount_minor: string | number; tax_minor: string | number; spent_at: string }>(
        `SELECT id, vendor, category, amount_minor, tax_minor, spent_at FROM expenses WHERE user_id = $1 AND spent_at >= $2 ORDER BY spent_at ASC LIMIT 2000`,
        [dataId, expenseSince]
      ))
    : [];

  const currency = invoices[0]?.currency ?? "USD";
  return {
    currency,
    invoices: invoices.map((r) => ({ ...r, total_minor: Number(r.total_minor), paid_minor: Number(r.paid_minor) })),
    expenses: expenses.map((r) => ({ id: r.id, vendor: r.vendor, category: r.category, amount_minor: Number(r.amount_minor) + Number(r.tax_minor || 0), spent_at: r.spent_at })),
    quotes: quotes.map((r) => ({ ...r, total_minor: Number(r.total_minor) })),
    bookings: bookings.map((r) => ({ ...r, price_minor: r.price_minor === null ? null : Number(r.price_minor) })),
  };
}

export async function loadCapacityInputs(dataId: string, now = new Date(), opts: { weeks?: number; lookbackWeeks?: number } = {}): Promise<CapacityInputs> {
  const weeks = opts.weeks ?? 8;
  const lookback = opts.lookbackWeeks ?? 4;
  const from = new Date(now.getTime() - (lookback + 1) * 7 * DAY_MS).toISOString();
  const to = new Date(now.getTime() + (weeks + 1) * 7 * DAY_MS).toISOString();
  const safe = async <T>(p: Promise<T[]>): Promise<T[]> => p.catch(() => []);

  const calendar = await queryOne<{ id: string }>(`SELECT id FROM calendars WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1`, [dataId]).catch(() => null);
  const [bookings, rules, hasTime, org] = await Promise.all([
    safe(query<{ id: string; status: string; starts_at: string; ends_at: string }>(
      `SELECT id, status, starts_at, ends_at FROM bookings WHERE user_id = $1 AND status IN ('confirmed', 'completed') AND starts_at >= $2 AND starts_at <= $3 ORDER BY starts_at ASC LIMIT 2000`,
      [dataId, from, to]
    )),
    calendar ? safe(query<{ weekday: number; start_minute: number; end_minute: number }>(`SELECT weekday, start_minute, end_minute FROM availability_rules WHERE calendar_id = $1`, [calendar.id])) : Promise.resolve([]),
    tableExists("time_entries"),
    queryOne<{ id: string }>(`SELECT id FROM organizations WHERE owner_user_id = $1`, [dataId]).catch(() => null),
  ]);
  const [timeEntries, members] = await Promise.all([
    hasTime
      ? safe(query<{ id: string; member_id: string | null; started_at: string; minutes: number | null; ref_kind: string | null }>(
          `SELECT id, member_id, started_at, minutes, ref_kind FROM time_entries WHERE user_id = $1 AND started_at >= $2 AND started_at <= $3 AND ended_at IS NOT NULL LIMIT 5000`,
          [dataId, from, now.toISOString()]
        ))
      : Promise.resolve([]),
    org
      ? safe(query<{ user_id: string | null; invited_email: string | null; role: string }>(`SELECT user_id, invited_email, role FROM memberships WHERE org_id = $1 AND status = 'active'`, [org.id]))
      : Promise.resolve([]),
  ]);

  const availability = rules.length ? rules : [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 9 * 60, end_minute: 17 * 60 }));
  const people = members
    .filter((m) => m.user_id)
    .map((m) => ({ id: m.user_id as string, label: m.invited_email ?? (m.role === "owner" ? "Owner" : m.role) }));
  return { bookings, availability, timeEntries, members: people.length ? people : [{ id: dataId, label: "Owner" }] };
}

export async function loadPricingHistory(dataId: string): Promise<PricingHistoryQuote[]> {
  const rows = await query<{ id: string; status: string; created_at: string; items: string | null }>(
    `SELECT q.id, q.status, q.created_at, v.items FROM quotes q
       LEFT JOIN quote_versions v ON v.quote_id = q.id AND v.version = q.current_version
      WHERE q.user_id = $1 AND q.status IN ('accepted', 'declined', 'expired')
      ORDER BY q.created_at DESC LIMIT 500`,
    [dataId]
  ).catch(() => []);
  return rows.map((r) => ({ id: r.id, status: r.status, created_at: r.created_at, items: parseItems(r.items).map((i) => ({ description: i.description, qty: i.qty, unit_minor: i.unit_minor })) }));
}

// ── Runners ─────────────────────────────────────────────────────────────────

export async function runCashflow(dataId: string, opts: CashflowOptions = {}): Promise<CashflowForecast & { currency: string }> {
  const inputs = await loadCashflowInputs(dataId, opts.now);
  return { ...cashflowForecast(inputs, opts), currency: inputs.currency };
}

export async function runCapacity(dataId: string, opts: CapacityOptions = {}): Promise<CapacityPlan> {
  const inputs = await loadCapacityInputs(dataId, opts.now, { weeks: opts.weeks, lookbackWeeks: opts.lookbackWeeks });
  return capacityPlan(inputs, opts);
}

export async function runPricing(dataId: string, items: PricingItem[]): Promise<PricingSuggestion> {
  const history = await loadPricingHistory(dataId);
  return pricingSuggestion(items, history);
}

// ── Narration ───────────────────────────────────────────────────────────────

export type NarrateKind = "cashflow" | "capacity" | "pricing";

export interface Narrative {
  summary: string;
  actions: string[];
}

const money = (minor: number, ccy: string) => `${ccy} ${(minor / 100).toFixed(0)}`;

/** Compact, number-dense digest so the prompt stays small and grounded. */
export function digest(kind: NarrateKind, data: unknown): string {
  if (kind === "cashflow") {
    const f = data as CashflowForecast & { currency?: string };
    const c = f.currency ?? "USD";
    const lines = [
      `Horizon ${f.weeks.length} weeks. Opening ${money(f.summary.openingBalance, c)}. Ending ${money(f.summary.endingBalance, c)} (confirmed only ${money(f.summary.endingBalanceConfirmed, c)}). Lowest confirmed ${money(f.summary.lowestBalance, c)} in week ${f.summary.lowestWeek ?? "-"}.`,
      `Receivables open ${money(f.summary.receivablesOpen, c)}, overdue ${money(f.summary.receivablesOverdue, c)}. Pipeline gross ${money(f.summary.pipelineGross, c)}. Weekly run-rate spend ${money(f.assumptions.weeklyRunRate, c)}. Median days to pay ${f.assumptions.medianDaysToPay ?? "unknown"}.`,
      `Recurring: ${f.assumptions.recurring.slice(0, 6).map((r) => `${r.label} ${money(r.amount_minor, c)}/${r.everyDays}d`).join("; ") || "none detected"}.`,
      `Weeks: ${f.weeks.map((w) => `${w.weekStart.slice(5)} in ${Math.round(w.inflowConfirmed / 100)}+${Math.round(w.inflowExpected / 100)} out ${Math.round((w.outflowRecurring + w.outflowRunRate) / 100)} bal ${Math.round(w.balanceConfirmed / 100)}`).join(" | ")}.`,
      `Risks: ${f.risks.map((r) => `[${r.severity}] ${r.message}`).join(" ") || "none"}.`,
    ];
    return lines.join("\n");
  }
  if (kind === "capacity") {
    const p = data as CapacityPlan;
    return [
      `${p.people} people × ${Math.round(p.weeklyMinutesPerPerson / 60)}h/week. Target ${Math.round(p.target * 100)}%. Baseline unscheduled work ${Math.round(p.baselineLoggedMinutes / 60)}h/week.`,
      `Weeks: ${p.weeks.map((w) => `${w.weekStart.slice(5)}${w.past ? "(past)" : ""} ${Math.round(w.utilisation * 100)}% (booked ${Math.round(w.bookedMinutes / 60)}h)`).join(" | ")}.`,
      `Members: ${p.members.map((m) => `${m.label} avg ${Math.round(m.avgUtilisation * 100)}%`).join("; ")}.`,
      `Bottleneck weeks: ${p.bottleneckWeeks.join(", ") || "none"}. Suggestion: ${p.suggestion.message}`,
    ].join("\n");
  }
  const s = data as PricingSuggestion;
  return [
    `History: ${s.overall.quotes} decided quotes, ${s.overall.won} won, ${s.overall.lost} lost (win rate ${Math.round(s.overall.winRate * 100)}%).`,
    ...s.items.map(
      (i) =>
        `Item "${i.description}": current ${(i.current_unit_minor / 100).toFixed(2)}, matches ${i.matches}, win prob now ${Math.round(i.expectedWinProbability * 100)}%` +
        (i.basis === "history" ? `, suggested ${(i.suggested_min_minor! / 100).toFixed(2)}–${(i.suggested_max_minor! / 100).toFixed(2)} (best ${(i.suggested_unit_minor! / 100).toFixed(2)}, win ${Math.round((i.suggestedWinProbability ?? 0) * 100)}%), EV delta ${(i.expectedValueDelta_minor / 100).toFixed(2)}` : ", insufficient history")
    ),
  ].join("\n");
}

function parseNarrative(raw: string): Narrative | null {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*|```\s*$/g, "");
  try {
    const v = JSON.parse(cleaned) as { summary?: unknown; actions?: unknown };
    const summary = typeof v.summary === "string" ? v.summary.trim() : "";
    const actions = Array.isArray(v.actions) ? v.actions.filter((a): a is string => typeof a === "string").map((a) => a.trim()).filter(Boolean).slice(0, 3) : [];
    if (!summary) return null;
    return { summary, actions };
  } catch {
    return null;
  }
}

/**
 * Plain-language summary + three actions, metered under feature "other".
 * Throws LlmNotConfiguredError when no provider is set up (routes map it to 503).
 */
export async function narrate(userId: string, kind: NarrateKind, data: unknown): Promise<Narrative> {
  const topic = kind === "cashflow" ? "a 12-week cash-flow forecast" : kind === "capacity" ? "a team capacity plan" : "quote pricing suggestions";
  const raw = await meteredComplete(
    userId,
    "other",
    [
      {
        role: "system",
        content:
          `You are a pragmatic small-business finance and operations adviser. You are given ${topic} computed from the business's own records. ` +
          `Write for an owner, not an analyst: plain language, no jargon, cite the numbers that matter. ` +
          `Reply with ONLY JSON: {"summary": "<2-3 sentences>", "actions": ["<action 1>", "<action 2>", "<action 3>"]}. Each action is one concrete sentence starting with a verb.`,
      },
      { role: "user", content: digest(kind, data) },
    ],
    { temperature: 0.3, maxTokens: 400 }
  );
  const parsed = parseNarrative(raw);
  if (parsed) return parsed;
  // Model ignored the format: keep the prose, no actions.
  return { summary: raw.trim().slice(0, 600) || "No narrative produced.", actions: [] };
}
