import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";
import { monthStart, nextRenewalAction } from "./rules";
import type { SubscriptionRow } from "./subscription";
import { advanceAfterRenewal, grantCreditsFor, renewalAmount } from "./webhook";

/** Cron entry points. Both are idempotent and safe to run concurrently. */

export interface RenewSummary {
  scanned: number;
  renewed: number;
  past_due: number;
  downgraded: number;
  cancelled: number;
  trials_expired: number;
}

async function terminate(sub: SubscriptionRow, reason: "cancelled" | "unpaid"): Promise<boolean> {
  const row = await queryOne<{ user_id: string }>(
    `UPDATE subscriptions SET plan_key = 'free', status = 'cancelled', cancel_at_period_end = FALSE,
            pending_plan_key = NULL, pending_interval = NULL, pending_seats = NULL, updated_at = NOW()
      WHERE user_id = $1 AND status = $2 RETURNING user_id`,
    [sub.user_id, sub.status]
  );
  if (!row) return false;
  void emitEvent(sub.user_id, { type: "subscription.cancelled", entity: "subscription", entityId: sub.user_id, data: { from: sub.plan_key, reason } });
  void emitEvent(sub.user_id, { type: "subscription.plan_changed", entity: "subscription", entityId: sub.user_id, data: { from: sub.plan_key, to: "free", reason } });
  return true;
}

export async function renewDue(limit = 100, now = new Date()): Promise<RenewSummary> {
  const out: RenewSummary = { scanned: 0, renewed: 0, past_due: 0, downgraded: 0, cancelled: 0, trials_expired: 0 };
  const iso = now.toISOString();
  const rows = await query<SubscriptionRow>(
    `SELECT * FROM subscriptions
      WHERE (status IN ('active','past_due') AND current_period_end <= $1) OR (status = 'trialing' AND trial_ends_at <= $1)
      ORDER BY current_period_end ASC LIMIT $2`,
    [iso, Math.min(Math.max(limit, 1), 500)]
  );
  for (const sub of rows) {
    out.scanned++;
    try {
      const action = nextRenewalAction(sub, now);
      if (action === "expire_trial") {
        const r = await queryOne<{ user_id: string }>(
          `UPDATE subscriptions SET plan_key = 'free', status = 'active', current_period_end = NULL, updated_at = NOW() WHERE user_id = $1 AND status = 'trialing' RETURNING user_id`,
          [sub.user_id]
        );
        if (r) {
          out.trials_expired++;
          void emitEvent(sub.user_id, { type: "subscription.plan_changed", entity: "subscription", entityId: sub.user_id, data: { from: sub.plan_key, to: "free", reason: "trial_expired" } });
        }
      } else if (action === "renew") {
        let cur: SubscriptionRow | null = sub;
        // Catch up on missed periods (cron outage), at most 3 per run.
        for (let i = 0; i < 3 && cur && cur.current_period_end && new Date(cur.current_period_end).getTime() <= now.getTime(); i++) {
          const r = renewalAmount(cur);
          const next: SubscriptionRow | null = await advanceAfterRenewal(cur, "simulated", now);
          if (!next) break;
          await query(
            `INSERT INTO plan_invoices (id, user_id, subscription_id, kind, plan_key, billing_interval, seats, period_start, period_end, amount_minor, currency, status, provider, paid_at)
             VALUES ($1,$2,$3,'renewal',$4,$5,$6,$7,$8,$9,$10,'paid','simulated',NOW())`,
            [randomUUID(), sub.user_id, sub.user_id, r.planKey, r.interval, r.seats, next.current_period_start ? new Date(next.current_period_start).toISOString() : null, next.current_period_end ? new Date(next.current_period_end).toISOString() : null, r.amountMinor, sub.currency]
          );
          out.renewed++;
          void emitEvent(sub.user_id, { type: "subscription.renewed", entity: "subscription", entityId: sub.user_id, data: { plan: next.plan_key, period_end: next.current_period_end } });
          if (r.planKey !== cur.plan_key) void emitEvent(sub.user_id, { type: "subscription.plan_changed", entity: "subscription", entityId: sub.user_id, data: { from: cur.plan_key, to: r.planKey, reason: "scheduled_change" } });
          await grantCreditsFor(next, now).catch(() => undefined);
          cur = next;
        }
      } else if (action === "past_due") {
        const r = await queryOne<{ user_id: string }>(`UPDATE subscriptions SET status = 'past_due', updated_at = NOW() WHERE user_id = $1 AND status = 'active' RETURNING user_id`, [sub.user_id]);
        if (r) {
          out.past_due++;
          void emitEvent(sub.user_id, { type: "subscription.past_due", entity: "subscription", entityId: sub.user_id, data: { plan: sub.plan_key } });
        }
      } else if (action === "downgrade") {
        if (await terminate(sub, "unpaid")) out.downgraded++;
      } else if (action === "cancel") {
        if (await terminate(sub, "cancelled")) out.cancelled++;
      }
    } catch (err) {
      console.error(`[plans] renewDue failed for ${sub.user_id}:`, err);
    }
  }
  return out;
}

/**
 * Post each entitled org's included monthly AI credits once per calendar
 * month. A `credits_granted` counter marks done orgs so repeated ticks are
 * cheap; the ledger ref (`plan/<YYYY-MM>`) is the real idempotency guard.
 */
export async function grantMonthlyCredits(limit = 100, now = new Date()): Promise<{ scanned: number; granted: number }> {
  const month = monthStart(now);
  const rows = await query<SubscriptionRow>(
    `SELECT s.* FROM subscriptions s
      WHERE s.status IN ('trialing','active','past_due')
        AND NOT EXISTS (SELECT 1 FROM usage_counters u WHERE u.user_id = s.user_id AND u.metric = 'credits_granted' AND u.period_start = $1::date)
      LIMIT $2`,
    [month, Math.min(Math.max(limit, 1), 500)]
  );
  let granted = 0;
  for (const sub of rows) {
    try {
      const r = await grantCreditsFor(sub, now);
      if (r.granted > 0) granted++;
      await query(
        `INSERT INTO usage_counters (user_id, metric, period_start, value) VALUES ($1, 'credits_granted', $2::date, 1) ON CONFLICT (user_id, metric, period_start) DO NOTHING`,
        [sub.user_id, month]
      );
    } catch (err) {
      console.error(`[plans] grantMonthlyCredits failed for ${sub.user_id}:`, err);
    }
  }
  return { scanned: rows.length, granted };
}
