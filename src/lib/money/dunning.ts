import { query } from "@/lib/dsql";
import { tableExists } from "@/lib/table-exists";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { emitEvent } from "@/lib/events/bus";
import { issueShareToken } from "@/lib/share-tokens";
import { formatMoney } from "./items";
import { businessName } from "./quotes";
import { getBillingSettings, DEFAULT_DUNNING_SCHEDULE } from "./settings";

/**
 * Payment terms follow-up ("dunning").
 *
 * - `markOverdue(limit)`: sent / partially paid invoices past `due_at` → `overdue` (+ `invoice.overdue`).
 * - `sendReminders(limit)`: one transactional email per step of the org's
 *   `dunning_schedule` (days relative to due; negative = before due). The
 *   contact-level `invoice_reminders_opt_out` flag suppresses reminders; the
 *   marketing-consent gate does not apply because these are transactional.
 *
 * Both are bounded sweeps, idempotent and safe to call from every cron tick.
 */

export const DAY_MS = 86_400_000;

/**
 * Pure: which reminder step (1-based) is due right now. Returns 0 when none,
 * or `reminderCount` when the next step has not been reached yet, so the
 * caller sends exactly when `dueStep > reminderCount`.
 */
export function dueReminderStep(dueAt: Date, now: Date, schedule: readonly number[] = DEFAULT_DUNNING_SCHEDULE): number {
  const sorted = [...schedule].sort((a, b) => a - b);
  let step = 0;
  for (const offset of sorted) {
    if (now.getTime() >= dueAt.getTime() + offset * DAY_MS) step++;
    else break;
  }
  return step;
}

/** Pure: the date of the next reminder after `reminderCount` sends, or null when the schedule is exhausted. */
export function nextReminderAt(dueAt: Date, reminderCount: number, schedule: readonly number[] = DEFAULT_DUNNING_SCHEDULE): Date | null {
  const sorted = [...schedule].sort((a, b) => a - b);
  const offset = sorted[reminderCount];
  return offset === undefined ? null : new Date(dueAt.getTime() + offset * DAY_MS);
}

export interface OverdueResult {
  scanned: number;
  marked: number;
}

export async function markOverdue(limit = 200): Promise<OverdueResult> {
  const cap = Math.min(Math.max(Math.floor(limit), 1), 1000);
  const due = await query<{ id: string; user_id: string; number: string; due_at: string; total_minor: string; paid_minor: string; currency: string }>(
    `SELECT id, user_id, number, due_at, total_minor, paid_minor, currency FROM invoices
      WHERE status IN ('sent', 'partially_paid') AND due_at IS NOT NULL AND due_at < NOW()
      ORDER BY due_at ASC LIMIT $1`,
    [cap]
  );
  const out: OverdueResult = { scanned: due.length, marked: 0 };
  for (const row of due) {
    const flipped = await query<{ id: string }>(
      `UPDATE invoices SET status = 'overdue', updated_at = NOW() WHERE id = $1 AND status IN ('sent', 'partially_paid') RETURNING id`,
      [row.id]
    );
    if (flipped.length === 0) continue;
    out.marked++;
    await emitEvent(row.user_id, {
      type: "invoice.overdue",
      entity: "invoice",
      entityId: row.id,
      data: { number: row.number, due_at: row.due_at, outstanding_minor: Number(row.total_minor) - Number(row.paid_minor), currency: row.currency },
    });
  }
  return out;
}

export interface ReminderResult {
  scanned: number;
  sent: number;
  skipped_opt_out: number;
}

interface Candidate {
  id: string;
  user_id: string;
  number: string;
  due_at: string;
  total_minor: string;
  paid_minor: string;
  currency: string;
  reminder_count: number | string | null;
  contact_email: string | null;
  contact_name: string | null;
  opt_out: boolean | null;
}

export async function sendReminders(limit = 100, now = new Date()): Promise<ReminderResult> {
  const cap = Math.min(Math.max(Math.floor(limit), 1), 500);
  const out: ReminderResult = { scanned: 0, sent: 0, skipped_opt_out: 0 };
  const hasOptOut = await tableExists("crm_contacts");
  const rows = await query<Candidate>(
    `SELECT i.id, i.user_id, i.number, i.due_at, i.total_minor, i.paid_minor, i.currency, i.reminder_count,
            c.email AS contact_email, c.full_name AS contact_name${hasOptOut ? ", c.invoice_reminders_opt_out AS opt_out" : ", NULL::boolean AS opt_out"}
       FROM invoices i LEFT JOIN crm_contacts c ON c.id = i.contact_id
      WHERE i.status IN ('sent', 'partially_paid', 'overdue') AND i.due_at IS NOT NULL
        AND i.due_at < $2 AND (i.last_reminder_at IS NULL OR i.last_reminder_at < $3)
      ORDER BY i.due_at ASC LIMIT $1`,
    // Widest pre-due window the schedule allows is 60 days; never remind twice within 20h.
    [cap, new Date(now.getTime() + 60 * DAY_MS).toISOString(), new Date(now.getTime() - 20 * 3_600_000).toISOString()]
  ).catch(() => [] as Candidate[]);
  out.scanned = rows.length;

  const settingsCache = new Map<string, Awaited<ReturnType<typeof getBillingSettings>>>();
  const nameCache = new Map<string, string>();
  for (const r of rows) {
    const to = r.contact_email?.trim();
    if (!to) continue;
    if (r.opt_out) {
      out.skipped_opt_out++;
      continue;
    }
    let settings = settingsCache.get(r.user_id);
    if (!settings) {
      settings = await getBillingSettings(r.user_id);
      settingsCache.set(r.user_id, settings);
    }
    const count = Number(r.reminder_count ?? 0);
    const step = dueReminderStep(new Date(r.due_at), now, settings.dunning_schedule);
    if (step <= count) continue;

    // Claim the step first so two workers never send the same reminder.
    const claimed = await query<{ id: string }>(
      `UPDATE invoices SET reminder_count = $2, last_reminder_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND COALESCE(reminder_count, 0) = $3 RETURNING id`,
      [r.id, step, count]
    );
    if (claimed.length === 0) continue;

    let from = nameCache.get(r.user_id);
    if (!from) {
      from = await businessName(r.user_id);
      nameCache.set(r.user_id, from);
    }
    const outstanding = Number(r.total_minor) - Number(r.paid_minor);
    const link = await issueShareToken(r.user_id, "invoice", r.id, 60, { recipient: to });
    const dueDate = new Date(r.due_at);
    const late = now.getTime() > dueDate.getTime();
    const days = Math.round(Math.abs(now.getTime() - dueDate.getTime()) / DAY_MS);
    const when = late ? (days === 0 ? "is due today" : `was due ${days} day${days === 1 ? "" : "s"} ago`) : `is due in ${days} day${days === 1 ? "" : "s"}`;
    await enqueueNotification(r.user_id, {
      channel: "email",
      recipient: to,
      subject: `${late && days > 0 ? "Overdue: " : "Reminder: "}invoice ${r.number} from ${from}`,
      body:
        `Hello${r.contact_name ? ` ${r.contact_name}` : ""},\n\n` +
        `Invoice ${r.number} for ${formatMoney(outstanding, r.currency)} ${when} (${dueDate.toDateString()}).\n\n` +
        `View and pay it here: ${link.url}\n\n` +
        `If you have already paid, thank you — please ignore this message.\n\n${from}`,
      data: { kind: "invoice_reminder", invoice_id: r.id, number: r.number, step, url: link.url },
    });
    out.sent++;
    await emitEvent(r.user_id, {
      type: "invoice.reminder_sent",
      entity: "invoice",
      entityId: r.id,
      data: { number: r.number, step, to, outstanding_minor: outstanding, currency: r.currency, due_at: r.due_at },
    });
  }
  return out;
}
