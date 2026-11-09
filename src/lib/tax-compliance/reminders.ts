import { query } from "@/lib/dsql";
import { tableExists } from "@/lib/table-exists";
import { emitEvent } from "@/lib/events/bus";
import type { FilingFrequency } from "./regimes";

/**
 * Filing reminders. Due dates are an approximation derived from the filing
 * frequency (a fixed day after the period closes) - the real statutory due date
 * depends on the jurisdiction and scheme, so reminders say "around".
 */

/** Days after period end by regime when the period closes; GSTR-1 is the 11th, VAT returns typically ~1 month. Verify locally. */
export const DUE_DAY_OFFSET: Readonly<Record<string, number>> = { india_gst: 11, eu_vat: 30, uk_vat: 37, us_sales: 20, generic: 30 };

export interface Period { start: Date; end: Date; due: Date }

/** Most recently closed period for `now`, and its approximate due date. */
export function lastClosedPeriod(freq: FilingFrequency, regime: string, now: Date): Period {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  let start: Date;
  let end: Date;
  if (freq === "monthly") {
    start = new Date(Date.UTC(y, m - 1, 1));
    end = new Date(Date.UTC(y, m, 0, 23, 59, 59));
  } else if (freq === "quarterly") {
    const q = Math.floor(m / 3);
    start = new Date(Date.UTC(y, (q - 1) * 3, 1));
    end = new Date(Date.UTC(y, q * 3, 0, 23, 59, 59));
  } else {
    start = new Date(Date.UTC(y - 1, 0, 1));
    end = new Date(Date.UTC(y, 0, 0, 23, 59, 59));
  }
  const due = new Date(end.getTime() + (DUE_DAY_OFFSET[regime] ?? 30) * 86_400_000);
  return { start, end, due };
}

/** Pure: should a reminder fire now? (due within the next 7 days and not yet past). */
export function reminderDue(due: Date, now: Date, leadDays = 7): boolean {
  const ms = due.getTime() - now.getTime();
  return ms >= 0 && ms <= leadDays * 86_400_000;
}

/** Cron hook: emits `tax.filing_due` once per org per period (deduped through tax_filings notes marker). */
export async function taxFilingReminders(limit = 200, now: Date = new Date()): Promise<{ checked: number; emitted: number }> {
  if (!(await tableExists("tax_profiles")) || !(await tableExists("tax_filings"))) return { checked: 0, emitted: 0 };
  const profiles = await query<{ user_id: string; regime: string; filing_frequency: string }>(
    `SELECT user_id, regime, filing_frequency FROM tax_profiles WHERE regime <> 'generic' LIMIT $1`,
    [Math.min(Math.max(limit, 1), 1000)]
  );
  let emitted = 0;
  for (const p of profiles) {
    const per = lastClosedPeriod(p.filing_frequency as FilingFrequency, p.regime, now);
    if (!reminderDue(per.due, now)) continue;
    const done = await query<{ id: string }>(
      `SELECT id FROM tax_filings WHERE user_id = $1 AND regime = $2 AND period_start = $3 AND status IN ('prepared','filed') LIMIT 1`,
      [p.user_id, p.regime, per.start.toISOString()]
    );
    if (done.length > 0) continue;
    const marker = `reminder:${p.regime}:${per.start.toISOString().slice(0, 10)}`;
    const sent = await query<{ id: string }>(`SELECT id FROM tax_filings WHERE user_id = $1 AND notes = $2 LIMIT 1`, [p.user_id, marker]);
    if (sent.length > 0) continue;
    // Reserve the marker as a void draft row first so concurrent ticks do not double-send.
    const id = `${p.user_id.slice(0, 8)}-${marker}`.slice(0, 80);
    const ins = await query<{ id: string }>(
      `INSERT INTO tax_filings (id, user_id, regime, period_start, period_end, status, totals, notes) VALUES ($1,$2,$3,$4,$5,'void','{}',$6) ON CONFLICT (id) DO NOTHING RETURNING id`,
      [id, p.user_id, p.regime, per.start.toISOString(), per.end.toISOString(), marker]
    ).catch(() => []);
    if (ins.length === 0) continue;
    await emitEvent(p.user_id, {
      type: "tax.filing_due", entity: "tax_profile", entityId: p.user_id,
      data: { regime: p.regime, period_start: per.start.toISOString().slice(0, 10), period_end: per.end.toISOString().slice(0, 10), due_around: per.due.toISOString().slice(0, 10) },
    });
    emitted++;
  }
  return { checked: profiles.length, emitted };
}
