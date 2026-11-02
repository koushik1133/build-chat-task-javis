/**
 * Cash-flow forecast — pure math, client-safe (no DB imports).
 *
 * Inflows:  open invoices placed on the week they are expected to be paid
 *           (due date, shifted by how late that contact historically pays),
 *           plus a probability-weighted pipeline (open quotes by stage and
 *           priced upcoming bookings).
 * Outflows: recurring expenses detected from history (same vendor/category on
 *           a steady cadence) projected forward, plus a weekly run-rate for
 *           everything else.
 * Every amount is in minor units of one currency.
 */

export interface CashflowInvoice {
  id: string;
  number?: string;
  contact_id: string | null;
  status: string;
  total_minor: number;
  paid_minor: number;
  due_at: string | null;
  sent_at: string | null;
  created_at: string;
  paid_at: string | null;
}

export interface CashflowExpense {
  id: string;
  vendor: string | null;
  category: string | null;
  amount_minor: number;
  spent_at: string;
}

export interface CashflowQuote {
  id: string;
  status: string;
  total_minor: number;
  valid_until: string | null;
  created_at: string;
  contact_id?: string | null;
}

export interface CashflowBooking {
  id: string;
  status: string;
  starts_at: string;
  price_minor: number | null;
}

export interface CashflowInputs {
  invoices: CashflowInvoice[];
  expenses: CashflowExpense[];
  quotes: CashflowQuote[];
  bookings: CashflowBooking[];
}

export interface CashflowOptions {
  /** Horizon, 1–52 weeks. Default 12. */
  weeks?: number;
  now?: Date;
  /** Cash on hand today (minor units). Default 0 — balances are then relative. */
  openingBalance?: number;
  /** Fallback days-to-pay when a contact has no history. Default 14. */
  defaultDaysToPay?: number;
}

export interface CashflowWeek {
  /** ISO date (Monday, UTC) of the week start. */
  weekStart: string;
  /** Receivables expected from invoices already issued. */
  inflowConfirmed: number;
  /** Probability-weighted pipeline (quotes, bookings). */
  inflowExpected: number;
  outflowRecurring: number;
  outflowRunRate: number;
  net: number;
  /** Opening + cumulative (confirmed + expected − outflow). */
  balance: number;
  /** Opening + cumulative (confirmed − outflow); ignores the pipeline. */
  balanceConfirmed: number;
}

export type CashflowRiskKind = "negative_balance" | "overdue_receivables" | "concentration" | "burn" | "no_data";

export interface CashflowRisk {
  kind: CashflowRiskKind;
  severity: "warn" | "serious";
  message: string;
  weekStart?: string;
  amount_minor?: number;
}

export interface RecurringExpense {
  key: string;
  label: string;
  amount_minor: number;
  everyDays: number;
  nextAt: string;
  occurrences: number;
}

export interface CashflowForecast {
  generatedAt: string;
  weeks: CashflowWeek[];
  risks: CashflowRisk[];
  assumptions: {
    defaultDaysToPay: number;
    medianDaysToPay: number | null;
    contactsWithHistory: number;
    weeklyRunRate: number;
    recurring: RecurringExpense[];
    stageProbabilities: Record<string, number>;
  };
  summary: {
    openingBalance: number;
    totalInflowConfirmed: number;
    totalInflowExpected: number;
    totalOutflow: number;
    endingBalance: number;
    endingBalanceConfirmed: number;
    lowestBalance: number;
    lowestWeek: string | null;
    receivablesOpen: number;
    receivablesOverdue: number;
    pipelineGross: number;
  };
}

export const STAGE_PROBABILITY: Record<string, number> = { draft: 0.15, sent: 0.4, viewed: 0.6 };
const BOOKING_PROBABILITY = 0.9;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

export function weekStartUtc(d: Date): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (x.getUTCDay() + 6) % 7; // Monday = 0
  x.setUTCDate(x.getUTCDate() - dow);
  return x;
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

/** Median days from issue (sent_at, else created_at) to paid_at, per contact and overall. */
export function daysToPay(invoices: CashflowInvoice[]): { byContact: Map<string, number>; overall: number | null } {
  const per = new Map<string, number[]>();
  const all: number[] = [];
  for (const inv of invoices) {
    if (inv.status !== "paid") continue;
    const paid = ms(inv.paid_at);
    const issued = ms(inv.sent_at) ?? ms(inv.created_at);
    if (paid === null || issued === null) continue;
    const days = Math.max(0, (paid - issued) / DAY_MS);
    all.push(days);
    if (inv.contact_id) {
      const list = per.get(inv.contact_id) ?? [];
      list.push(days);
      per.set(inv.contact_id, list);
    }
  }
  const byContact = new Map<string, number>();
  for (const [c, list] of per) byContact.set(c, median(list) ?? 0);
  return { byContact, overall: median(all) };
}

/** Detect expenses that repeat on a steady cadence (same vendor, else category). */
export function detectRecurring(expenses: CashflowExpense[], now: Date): { recurring: RecurringExpense[]; recurringIds: Set<string> } {
  const groups = new Map<string, CashflowExpense[]>();
  for (const e of expenses) {
    const key = (e.vendor?.trim().toLowerCase() || `category:${(e.category ?? "general").toLowerCase()}`);
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }
  const recurring: RecurringExpense[] = [];
  const recurringIds = new Set<string>();
  for (const [key, list] of groups) {
    // Two data points are not a pattern: three or more on a steady cadence.
    if (list.length < 3) continue;
    const sorted = [...list].sort((a, b) => new Date(a.spent_at).getTime() - new Date(b.spent_at).getTime());
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) gaps.push((new Date(sorted[i].spent_at).getTime() - new Date(sorted[i - 1].spent_at).getTime()) / DAY_MS);
    const gap = median(gaps);
    if (gap === null || gap < 6 || gap > 95) continue;
    // Cadence must be steady: no gap more than 40% off the median.
    if (gaps.some((g) => Math.abs(g - gap) > gap * 0.4 + 1)) continue;
    const amount = median(sorted.map((e) => Number(e.amount_minor) || 0)) ?? 0;
    if (amount <= 0) continue;
    const last = new Date(sorted[sorted.length - 1].spent_at).getTime();
    let next = last + gap * DAY_MS;
    while (next < now.getTime() - DAY_MS) next += gap * DAY_MS;
    recurring.push({
      key,
      label: sorted[sorted.length - 1].vendor?.trim() || (sorted[0].category ?? "general"),
      amount_minor: Math.round(amount),
      everyDays: Math.round(gap),
      nextAt: new Date(next).toISOString(),
      occurrences: sorted.length,
    });
    for (const e of sorted) recurringIds.add(e.id);
  }
  recurring.sort((a, b) => b.amount_minor - a.amount_minor);
  return { recurring, recurringIds };
}

export function cashflowForecast(inputs: CashflowInputs, opts: CashflowOptions = {}): CashflowForecast {
  const now = opts.now ?? new Date();
  const horizon = Math.min(Math.max(Math.round(opts.weeks ?? 12), 1), 52);
  const opening = Math.round(opts.openingBalance ?? 0);
  const defaultDays = opts.defaultDaysToPay ?? 14;
  const start = weekStartUtc(now);
  const end = start.getTime() + horizon * WEEK_MS;

  const weeks: CashflowWeek[] = Array.from({ length: horizon }, (_, i) => ({
    weekStart: isoDate(new Date(start.getTime() + i * WEEK_MS)),
    inflowConfirmed: 0, inflowExpected: 0, outflowRecurring: 0, outflowRunRate: 0, net: 0, balance: 0, balanceConfirmed: 0,
  }));
  const bucket = (t: number): number | null => {
    const clamped = Math.max(t, start.getTime()); // anything already due lands in the current week
    if (clamped >= end) return null;
    return Math.floor((clamped - start.getTime()) / WEEK_MS);
  };

  // ── Receivables ────────────────────────────────────────────────────────────
  const { byContact, overall } = daysToPay(inputs.invoices);
  let receivablesOpen = 0;
  let receivablesOverdue = 0;
  const byContactOpen = new Map<string, number>();
  for (const inv of inputs.invoices) {
    if (!["sent", "partially_paid", "overdue"].includes(inv.status)) continue;
    const remaining = Math.max(0, Math.round(Number(inv.total_minor) - Number(inv.paid_minor)));
    if (remaining <= 0) continue;
    receivablesOpen += remaining;
    const key = inv.contact_id ?? "__none__";
    byContactOpen.set(key, (byContactOpen.get(key) ?? 0) + remaining);
    const due = ms(inv.due_at) ?? (ms(inv.sent_at) ?? ms(inv.created_at) ?? now.getTime()) + defaultDays * DAY_MS;
    const contactDays = inv.contact_id ? byContact.get(inv.contact_id) : undefined;
    const typicalDays = contactDays ?? overall ?? defaultDays;
    // How late this contact usually pays relative to a default term; never pulls a date earlier than due.
    const lateness = Math.max(0, typicalDays - defaultDays) * DAY_MS;
    let expected = due + lateness;
    if (due < now.getTime()) {
      receivablesOverdue += remaining;
      // Overdue: assume a follow-up collects it within a short window.
      expected = now.getTime() + Math.min(typicalDays, defaultDays) * DAY_MS;
    }
    const b = bucket(expected);
    if (b !== null) weeks[b].inflowConfirmed += remaining;
  }

  // ── Pipeline ───────────────────────────────────────────────────────────────
  let pipelineGross = 0;
  for (const q of inputs.quotes) {
    const p = STAGE_PROBABILITY[q.status];
    if (!p) continue;
    const validUntil = ms(q.valid_until);
    if (validUntil !== null && validUntil < now.getTime()) continue; // expired
    const total = Math.round(Number(q.total_minor) || 0);
    if (total <= 0) continue;
    pipelineGross += total;
    const decide = validUntil ?? (ms(q.created_at) ?? now.getTime()) + 30 * DAY_MS;
    const days = (q.contact_id ? byContact.get(q.contact_id) : undefined) ?? overall ?? defaultDays;
    const b = bucket(Math.max(decide, now.getTime()) + days * DAY_MS);
    if (b !== null) weeks[b].inflowExpected += Math.round(total * p);
  }
  for (const bk of inputs.bookings) {
    if (bk.status !== "confirmed") continue;
    const price = Math.round(Number(bk.price_minor) || 0);
    const t = ms(bk.starts_at);
    if (price <= 0 || t === null || t < now.getTime()) continue;
    pipelineGross += price;
    const b = bucket(t);
    if (b !== null) weeks[b].inflowExpected += Math.round(price * BOOKING_PROBABILITY);
  }

  // ── Outflows ───────────────────────────────────────────────────────────────
  const { recurring, recurringIds } = detectRecurring(inputs.expenses, now);
  for (const r of recurring) {
    for (let t = new Date(r.nextAt).getTime(); t < end; t += r.everyDays * DAY_MS) {
      const b = bucket(t);
      if (b !== null) weeks[b].outflowRecurring += r.amount_minor;
    }
  }
  const lookbackStart = now.getTime() - 90 * DAY_MS;
  let adHoc = 0;
  let earliest = now.getTime();
  for (const e of inputs.expenses) {
    const t = ms(e.spent_at);
    if (t === null || t < lookbackStart || t > now.getTime() || recurringIds.has(e.id)) continue;
    adHoc += Number(e.amount_minor) || 0;
    earliest = Math.min(earliest, t);
  }
  const observedWeeks = Math.max(1, Math.min(90, (now.getTime() - earliest) / DAY_MS + 7) / 7);
  const weeklyRunRate = Math.round(adHoc / observedWeeks);
  for (const w of weeks) w.outflowRunRate = weeklyRunRate;

  // ── Balances ───────────────────────────────────────────────────────────────
  let balance = opening;
  let balanceConfirmed = opening;
  let lowest = Number.POSITIVE_INFINITY;
  let lowestWeek: string | null = null;
  const totals = { inC: 0, inE: 0, out: 0 };
  for (const w of weeks) {
    const out = w.outflowRecurring + w.outflowRunRate;
    w.net = w.inflowConfirmed + w.inflowExpected - out;
    balance += w.net;
    balanceConfirmed += w.inflowConfirmed - out;
    w.balance = balance;
    w.balanceConfirmed = balanceConfirmed;
    totals.inC += w.inflowConfirmed;
    totals.inE += w.inflowExpected;
    totals.out += out;
    if (balanceConfirmed < lowest) {
      lowest = balanceConfirmed;
      lowestWeek = w.weekStart;
    }
  }

  // ── Risks ──────────────────────────────────────────────────────────────────
  const risks: CashflowRisk[] = [];
  const hasData = inputs.invoices.length + inputs.expenses.length + inputs.quotes.length + inputs.bookings.length > 0;
  if (!hasData) {
    risks.push({ kind: "no_data", severity: "warn", message: "No invoices, expenses, quotes or bookings yet — the forecast is empty until you add some." });
  }
  const firstNegative = weeks.find((w) => w.balanceConfirmed < 0);
  if (firstNegative && hasData) {
    risks.push({
      kind: "negative_balance",
      severity: "serious",
      message: `Confirmed cash goes negative in the week of ${firstNegative.weekStart} (low point ${lowestWeek ?? firstNegative.weekStart}). Pipeline wins would ${balance >= 0 ? "cover it" : "not cover it"}.`,
      weekStart: firstNegative.weekStart,
      amount_minor: lowest,
    });
  }
  if (receivablesOverdue > 0) {
    risks.push({ kind: "overdue_receivables", severity: receivablesOverdue > receivablesOpen * 0.5 ? "serious" : "warn", message: `Overdue invoices total ${Math.round(receivablesOverdue / 100)} (${Math.round((receivablesOverdue / Math.max(1, receivablesOpen)) * 100)}% of open receivables).`, amount_minor: receivablesOverdue });
  }
  if (receivablesOpen > 0) {
    for (const [c, amt] of byContactOpen) {
      if (c !== "__none__" && amt / receivablesOpen >= 0.4 && byContactOpen.size > 1) {
        risks.push({ kind: "concentration", severity: "warn", message: `One client owes ${Math.round((amt / receivablesOpen) * 100)}% of open receivables — a late payment there moves the whole forecast.`, amount_minor: amt });
        break;
      }
    }
  }
  const burnWeeks = weeks.filter((w) => w.inflowConfirmed + w.inflowExpected < w.outflowRecurring + w.outflowRunRate).length;
  if (hasData && totals.out > 0 && burnWeeks >= Math.ceil(horizon * 0.66)) {
    risks.push({ kind: "burn", severity: "warn", message: `Outflows exceed expected inflows in ${burnWeeks} of ${horizon} weeks. Pipeline needs to grow or spend needs to fall.` });
  }

  return {
    generatedAt: now.toISOString(),
    weeks,
    risks,
    assumptions: {
      defaultDaysToPay: defaultDays,
      medianDaysToPay: overall === null ? null : Math.round(overall * 10) / 10,
      contactsWithHistory: byContact.size,
      weeklyRunRate,
      recurring,
      stageProbabilities: { ...STAGE_PROBABILITY, booking: BOOKING_PROBABILITY },
    },
    summary: {
      openingBalance: opening,
      totalInflowConfirmed: totals.inC,
      totalInflowExpected: totals.inE,
      totalOutflow: totals.out,
      endingBalance: balance,
      endingBalanceConfirmed: balanceConfirmed,
      lowestBalance: Number.isFinite(lowest) ? lowest : opening,
      lowestWeek,
      receivablesOpen,
      receivablesOverdue,
      pipelineGross,
    },
  };
}
