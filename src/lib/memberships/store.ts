import { query, queryOne } from "@/lib/dsql";
import { likeContains } from "@/lib/like";
import { keysetClause, keysetOrder, type Cursor } from "@/lib/public-api/pagination";
import { PLAN_INTERVALS, SUB_STATUSES, type ChargeStatus, type PlanInterval, type SubStatus } from "./pure";

/** Subscription rows, DTOs and read queries (no billing side effects). */

export interface SubRow {
  id: string;
  user_id: string;
  plan_id: string;
  contact_id: string;
  status: string;
  quantity: number;
  start_at: string | Date;
  trial_ends_at: string | Date | null;
  current_period_start: string | Date | null;
  current_period_end: string | Date | null;
  next_charge_at: string | Date | null;
  cancel_at_period_end: boolean;
  cancelled_at: string | Date | null;
  pause_until: string | Date | null;
  payment_ref: string | null;
  provider: string | null;
  failed_attempts: number;
  last_failure_at: string | Date | null;
  last_invoice_id: string | null;
  pending_adjustment_minor: string | number;
  trial_reminder_at: string | Date | null;
  join_token_hash: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export const SUB_COLS =
  "id, user_id, plan_id, contact_id, status, quantity, start_at, trial_ends_at, current_period_start, current_period_end, next_charge_at, cancel_at_period_end, cancelled_at, pause_until, payment_ref, provider, failed_attempts, last_failure_at, last_invoice_id, pending_adjustment_minor, trial_reminder_at, join_token_hash, created_at, updated_at";

const iso = (v: string | Date | null): string | null => (v === null || v === undefined ? null : new Date(v).toISOString());

export interface SubscriptionDTO {
  id: string;
  plan_id: string;
  plan_name: string;
  plan_slug: string;
  contact_id: string;
  contact_name: string | null;
  contact_email: string | null;
  status: SubStatus;
  quantity: number;
  amount_minor: number;
  currency: string;
  interval: PlanInterval;
  interval_count: number;
  start_at: string;
  trial_ends_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  next_charge_at: string | null;
  cancel_at_period_end: boolean;
  cancelled_at: string | null;
  pause_until: string | null;
  has_payment_method: boolean;
  provider: string | null;
  failed_attempts: number;
  last_failure_at: string | null;
  last_invoice_id: string | null;
  pending_adjustment_minor: number;
  created_at: string;
  updated_at: string;
}

export type JoinedSubRow = SubRow & {
  plan_name: string;
  plan_slug: string;
  amount_minor: string | number;
  currency: string;
  interval: string;
  interval_count: number;
  contact_name: string | null;
  contact_email: string | null;
};

const JOIN_SELECT = `${SUB_COLS.split(", ").map((c) => `s.${c}`).join(", ")}, p.name AS plan_name, p.slug AS plan_slug, p.amount_minor, p.currency, p.interval, p.interval_count,
       c.full_name AS contact_name, c.email AS contact_email
  FROM customer_subscriptions s JOIN membership_plans p ON p.id = s.plan_id LEFT JOIN crm_contacts c ON c.id = s.contact_id`;

export function toSubDTO(r: JoinedSubRow): SubscriptionDTO {
  return {
    id: r.id,
    plan_id: r.plan_id,
    plan_name: r.plan_name,
    plan_slug: r.plan_slug,
    contact_id: r.contact_id,
    contact_name: r.contact_name,
    contact_email: r.contact_email,
    status: (SUB_STATUSES as readonly string[]).includes(r.status) ? (r.status as SubStatus) : "expired",
    quantity: Number(r.quantity),
    amount_minor: Number(r.amount_minor),
    currency: r.currency,
    interval: (PLAN_INTERVALS as readonly string[]).includes(r.interval) ? (r.interval as PlanInterval) : "month",
    interval_count: Number(r.interval_count),
    start_at: new Date(r.start_at).toISOString(),
    trial_ends_at: iso(r.trial_ends_at),
    current_period_start: iso(r.current_period_start),
    current_period_end: iso(r.current_period_end),
    next_charge_at: iso(r.next_charge_at),
    cancel_at_period_end: Boolean(r.cancel_at_period_end),
    cancelled_at: iso(r.cancelled_at),
    pause_until: iso(r.pause_until),
    has_payment_method: Boolean(r.payment_ref),
    provider: r.provider,
    failed_attempts: Number(r.failed_attempts),
    last_failure_at: iso(r.last_failure_at),
    last_invoice_id: r.last_invoice_id,
    pending_adjustment_minor: Number(r.pending_adjustment_minor),
    created_at: new Date(r.created_at).toISOString(),
    updated_at: new Date(r.updated_at).toISOString(),
  };
}

export async function getSubRow(dataId: string, id: string): Promise<SubRow | null> {
  return queryOne<SubRow>(`SELECT ${SUB_COLS} FROM customer_subscriptions WHERE id = $1 AND user_id = $2`, [id, dataId]);
}

export async function getSubscription(dataId: string, id: string): Promise<SubscriptionDTO | null> {
  const r = await queryOne<JoinedSubRow>(`SELECT ${JOIN_SELECT} WHERE s.id = $1 AND s.user_id = $2`, [id, dataId]);
  return r ? toSubDTO(r) : null;
}

export interface ListSubsOpts {
  status?: SubStatus | null;
  planId?: string | null;
  contactId?: string | null;
  q?: string | null;
  limit?: number;
  cursor?: Cursor | null;
}

export async function listSubscriptions(dataId: string, opts: ListSubsOpts = {}): Promise<SubscriptionDTO[]> {
  const params: unknown[] = [dataId];
  let sql = `SELECT ${JOIN_SELECT} WHERE s.user_id = $1`;
  if (opts.status) {
    params.push(opts.status);
    sql += ` AND s.status = $${params.length}`;
  }
  if (opts.planId) {
    params.push(opts.planId);
    sql += ` AND s.plan_id = $${params.length}`;
  }
  if (opts.contactId) {
    params.push(opts.contactId);
    sql += ` AND s.contact_id = $${params.length}`;
  }
  if (opts.q?.trim()) {
    params.push(likeContains(opts.q.trim().toLowerCase().slice(0, 100)));
    sql += ` AND (lower(c.full_name) LIKE $${params.length} OR lower(c.email) LIKE $${params.length} OR lower(p.name) LIKE $${params.length})`;
  }
  sql += keysetClause(opts.cursor, params, { alias: "s." });
  params.push(Math.min(Math.max(opts.limit ?? 50, 1), 500));
  sql += ` ORDER BY ${keysetOrder("s.")} LIMIT $${params.length}`;
  return (await query<JoinedSubRow>(sql, params)).map(toSubDTO);
}

export interface ChargeRow {
  id: string;
  user_id: string;
  subscription_id: string;
  invoice_id: string | null;
  period_start: string | Date;
  period_end: string | Date;
  amount_minor: string | number;
  currency: string;
  status: string;
  attempt: number;
  provider_ref: string | null;
  error: string | null;
  created_at: string | Date;
}
export const CHARGE_COLS = "id, user_id, subscription_id, invoice_id, period_start, period_end, amount_minor, currency, status, attempt, provider_ref, error, created_at";

export interface ChargeDTO {
  id: string;
  subscription_id: string;
  invoice_id: string | null;
  period_start: string;
  period_end: string;
  amount_minor: number;
  currency: string;
  status: ChargeStatus;
  attempt: number;
  provider_ref: string | null;
  error: string | null;
  created_at: string;
}

export function toChargeDTO(r: ChargeRow): ChargeDTO {
  return {
    id: r.id,
    subscription_id: r.subscription_id,
    invoice_id: r.invoice_id,
    period_start: new Date(r.period_start).toISOString(),
    period_end: new Date(r.period_end).toISOString(),
    amount_minor: Number(r.amount_minor),
    currency: r.currency,
    status: (["pending", "paid", "failed", "void"].includes(r.status) ? r.status : "pending") as ChargeStatus,
    attempt: Number(r.attempt),
    provider_ref: r.provider_ref,
    error: r.error,
    created_at: new Date(r.created_at).toISOString(),
  };
}

export async function listCharges(dataId: string, subscriptionId: string, limit = 50): Promise<ChargeDTO[]> {
  const rows = await query<ChargeRow>(
    `SELECT ${CHARGE_COLS} FROM subscription_charges WHERE user_id = $1 AND subscription_id = $2 ORDER BY period_start DESC LIMIT $3`,
    [dataId, subscriptionId, Math.min(Math.max(limit, 1), 200)]
  );
  return rows.map(toChargeDTO);
}
