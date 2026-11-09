import { randomUUID } from "crypto";
import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { tableExists } from "@/lib/table-exists";
import { emitEvent } from "@/lib/events/bus";
import { CurrencySchema, LineItemsSchema, parseItems, type LineItem } from "./items";
import { createInvoice, sendInvoice } from "./invoices";
import { keysetClause, keysetOrder, type Cursor } from "@/lib/public-api/pagination";

/**
 * Recurring invoices. A schedule owns a line-item template and a cadence;
 * `runDueSchedules` claims each due row with a conditional UPDATE on
 * `next_run_at` (race-safe across workers), creates the invoice through the
 * regular `createInvoice`, optionally sends it, and advances the cadence.
 */

import { advanceNextRun, SCHEDULE_INTERVALS, type ScheduleInterval } from "./cadence";

export { SCHEDULE_INTERVALS, type ScheduleInterval };
export type ScheduleStatus = "active" | "paused" | "ended";

export interface ScheduleDTO {
  id: string;
  contact_id: string | null;
  contact_name: string | null;
  contact_email: string | null;
  name: string;
  items: LineItem[];
  currency: string;
  interval: ScheduleInterval;
  interval_count: number;
  day_of_month: number | null;
  next_run_at: string;
  end_at: string | null;
  auto_send: boolean;
  terms_days: number | null;
  notes: string | null;
  status: ScheduleStatus;
  last_invoice_id: string | null;
  last_run_at: string | null;
  run_count: number;
  created_at: string;
  updated_at: string;
}

interface Row {
  id: string;
  user_id: string;
  contact_id: string | null;
  contact_name: string | null;
  contact_email: string | null;
  name: string;
  items: string | null;
  currency: string;
  interval: ScheduleInterval;
  interval_count: number | string;
  day_of_month: number | string | null;
  next_run_at: string | Date;
  end_at: string | Date | null;
  auto_send: boolean | null;
  terms_days: number | string | null;
  notes: string | null;
  status: ScheduleStatus;
  last_invoice_id: string | null;
  last_run_at: string | Date | null;
  run_count: number | string;
  created_at: string | Date;
  updated_at: string | Date;
}

const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: string | Date | null | undefined): string | null => (v === null || v === undefined ? null : iso(v));

function toDTO(r: Row): ScheduleDTO {
  return {
    id: r.id,
    contact_id: r.contact_id,
    contact_name: r.contact_name,
    contact_email: r.contact_email,
    name: r.name,
    items: parseItems(r.items),
    currency: r.currency,
    interval: r.interval,
    interval_count: Number(r.interval_count),
    day_of_month: r.day_of_month === null ? null : Number(r.day_of_month),
    next_run_at: iso(r.next_run_at),
    end_at: isoOrNull(r.end_at),
    auto_send: Boolean(r.auto_send),
    terms_days: r.terms_days === null ? null : Number(r.terms_days),
    notes: r.notes,
    status: r.status,
    last_invoice_id: r.last_invoice_id,
    last_run_at: isoOrNull(r.last_run_at),
    run_count: Number(r.run_count),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

const SELECT = `
  SELECT s.*, c.full_name AS contact_name, c.email AS contact_email
    FROM invoice_schedules s LEFT JOIN crm_contacts c ON c.id = s.contact_id`;

export { advanceNextRun, previewRuns } from "./cadence";

/* ─── CRUD ─────────────────────────────────────────────────────────────── */

export const ScheduleInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    contact_id: z.string().max(100).nullable().optional(),
    items: LineItemsSchema.min(1),
    currency: CurrencySchema.optional(),
    interval: z.enum(SCHEDULE_INTERVALS as [string, ...string[]]).default("monthly"),
    interval_count: z.number().int().min(1).max(52).default(1),
    day_of_month: z.number().int().min(1).max(31).nullable().optional(),
    next_run_at: z.string().datetime({ offset: true }),
    end_at: z.string().datetime({ offset: true }).nullable().optional(),
    auto_send: z.boolean().default(false),
    terms_days: z.number().int().min(0).max(365).nullable().optional(),
    notes: z.string().max(4000).nullable().optional(),
  })
  .strict();
export type ScheduleInput = z.infer<typeof ScheduleInputSchema>;
export const SchedulePatchSchema = ScheduleInputSchema.partial().extend({ status: z.enum(["active", "paused"]).optional() }).strict();
export type SchedulePatch = z.infer<typeof SchedulePatchSchema>;

export async function listSchedules(dataId: string, opts: { status?: string; limit?: number; cursor?: Cursor | null } = {}): Promise<ScheduleDTO[]> {
  if (!(await tableExists("invoice_schedules"))) return [];
  const params: unknown[] = [dataId];
  let sql = `${SELECT} WHERE s.user_id = $1`;
  if (opts.status) {
    params.push(opts.status);
    sql += ` AND s.status = $${params.length}`;
  }
  sql += keysetClause(opts.cursor, params, { alias: "s." });
  params.push(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  sql += ` ORDER BY ${keysetOrder("s.")} LIMIT $${params.length}`;
  return (await query<Row>(sql, params)).map(toDTO);
}

export async function getSchedule(dataId: string, id: string): Promise<ScheduleDTO | null> {
  const row = await queryOne<Row>(`${SELECT} WHERE s.id = $1 AND s.user_id = $2`, [id, dataId]);
  return row ? toDTO(row) : null;
}

export async function createSchedule(dataId: string, input: ScheduleInput): Promise<ScheduleDTO> {
  if (input.contact_id) {
    const c = await queryOne(`SELECT id FROM crm_contacts WHERE id = $1 AND user_id = $2`, [input.contact_id, dataId]);
    if (!c) throw new Error("Contact not found");
  }
  const id = randomUUID();
  await query(
    `INSERT INTO invoice_schedules (id, user_id, contact_id, name, items, currency, interval, interval_count, day_of_month, next_run_at, end_at, auto_send, terms_days, notes, status, run_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'active', 0)`,
    [
      id, dataId, input.contact_id ?? null, input.name, JSON.stringify(input.items), (input.currency ?? "USD").toUpperCase(),
      input.interval, input.interval_count, input.day_of_month ?? null, input.next_run_at, input.end_at ?? null,
      input.auto_send, input.terms_days ?? null, input.notes ?? null,
    ]
  );
  const out = await getSchedule(dataId, id);
  if (!out) throw new Error("Schedule vanished after insert");
  return out;
}

export async function updateSchedule(dataId: string, id: string, patch: SchedulePatch): Promise<ScheduleDTO> {
  const cur = await getSchedule(dataId, id);
  if (!cur) throw new Error("Schedule not found");
  if (cur.status === "ended" && patch.status !== "active") throw new Error("Schedule has ended; set a new next run date and status active to restart it");
  if (patch.contact_id) {
    const c = await queryOne(`SELECT id FROM crm_contacts WHERE id = $1 AND user_id = $2`, [patch.contact_id, dataId]);
    if (!c) throw new Error("Contact not found");
  }
  const sets: string[] = ["updated_at = NOW()"];
  const params: unknown[] = [id, dataId];
  const push = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.name !== undefined) push("name", patch.name);
  if (patch.contact_id !== undefined) push("contact_id", patch.contact_id);
  if (patch.items !== undefined) push("items", JSON.stringify(patch.items));
  if (patch.currency !== undefined) push("currency", patch.currency.toUpperCase());
  if (patch.interval !== undefined) push("interval", patch.interval);
  if (patch.interval_count !== undefined) push("interval_count", patch.interval_count);
  if (patch.day_of_month !== undefined) push("day_of_month", patch.day_of_month);
  if (patch.next_run_at !== undefined) push("next_run_at", patch.next_run_at);
  if (patch.end_at !== undefined) push("end_at", patch.end_at);
  if (patch.auto_send !== undefined) push("auto_send", patch.auto_send);
  if (patch.terms_days !== undefined) push("terms_days", patch.terms_days);
  if (patch.notes !== undefined) push("notes", patch.notes);
  if (patch.status !== undefined) push("status", patch.status);
  await query(`UPDATE invoice_schedules SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2`, params);
  const out = await getSchedule(dataId, id);
  if (!out) throw new Error("Schedule not found");
  return out;
}

export async function deleteSchedule(dataId: string, id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(`DELETE FROM invoice_schedules WHERE id = $1 AND user_id = $2 RETURNING id`, [id, dataId]);
  return rows.length > 0;
}

/* ─── execution ────────────────────────────────────────────────────────── */

export interface RunOutcome {
  schedule_id: string;
  invoice_id: string | null;
  sent: boolean;
  status: ScheduleStatus;
  next_run_at: string | null;
  error?: string;
}

/**
 * Execute one schedule once (used by the cron sweep and "run now"). The claim
 * is a conditional UPDATE that moves `next_run_at` forward; a worker that
 * loses the race gets zero rows and does nothing.
 */
export async function runSchedule(dataId: string, id: string, opts: { force?: boolean; now?: Date } = {}): Promise<RunOutcome> {
  const now = opts.now ?? new Date();
  const s = await getSchedule(dataId, id);
  if (!s) throw new Error("Schedule not found");
  if (s.status !== "active") throw new Error(`Schedule is ${s.status}`);
  if (!opts.force && new Date(s.next_run_at).getTime() > now.getTime()) throw new Error("Schedule is not due yet");
  const invoiceDate = opts.force && new Date(s.next_run_at).getTime() > now.getTime() ? now : new Date(s.next_run_at);
  const next = advanceNextRun(invoiceDate, s.interval, s.interval_count, s.day_of_month);
  const ended = Boolean(s.end_at && next.getTime() > new Date(s.end_at).getTime());

  const claimed = await query<{ id: string }>(
    `UPDATE invoice_schedules SET next_run_at = $3, status = $4, updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status = 'active' AND next_run_at = $5 RETURNING id`,
    [id, dataId, next.toISOString(), ended ? "ended" : "active", s.next_run_at]
  );
  if (claimed.length === 0) return { schedule_id: id, invoice_id: null, sent: false, status: s.status, next_run_at: s.next_run_at, error: "claimed by another worker" };

  let invoiceId: string | null = null;
  let sent = false;
  let error: string | undefined;
  try {
    const inv = await createInvoice(dataId, {
      contact_id: s.contact_id,
      currency: s.currency,
      items: s.items,
      terms_days: s.terms_days,
      notes: s.notes,
      schedule_id: s.id,
    });
    invoiceId = inv.id;
    await query(`UPDATE invoice_schedules SET last_invoice_id = $3, last_run_at = NOW(), run_count = run_count + 1 WHERE id = $1 AND user_id = $2`, [id, dataId, inv.id]);
    await emitEvent(dataId, {
      type: "invoice.scheduled_created",
      entity: "invoice",
      entityId: inv.id,
      data: { schedule_id: s.id, schedule_name: s.name, number: inv.number, total_minor: inv.total_minor, currency: inv.currency, contact_id: s.contact_id, auto_send: s.auto_send },
    });
    if (s.auto_send) {
      if (s.contact_email) {
        await sendInvoice(dataId, inv.id, {});
        sent = true;
      } else {
        error = "auto_send skipped: contact has no email";
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error(`[recurring] schedule ${id} failed:`, err);
  }
  return { schedule_id: id, invoice_id: invoiceId, sent, status: ended ? "ended" : "active", next_run_at: ended ? null : next.toISOString(), error };
}

export interface SweepResult {
  scanned: number;
  created: number;
  sent: number;
  failed: number;
}

/** Cron hook: run every active schedule whose `next_run_at` has passed. */
export async function runDueSchedules(limit = 50, now = new Date()): Promise<SweepResult> {
  const out: SweepResult = { scanned: 0, created: 0, sent: 0, failed: 0 };
  if (!(await tableExists("invoice_schedules"))) return out;
  const cap = Math.min(Math.max(Math.floor(limit), 1), 500);
  const due = await query<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM invoice_schedules WHERE status = 'active' AND next_run_at <= $1 ORDER BY next_run_at ASC LIMIT $2`,
    [now.toISOString(), cap]
  );
  out.scanned = due.length;
  for (const d of due) {
    try {
      const r = await runSchedule(d.user_id, d.id, { now });
      if (r.invoice_id) out.created++;
      if (r.sent) out.sent++;
      if (r.error && !r.invoice_id && r.error !== "claimed by another worker") out.failed++;
    } catch (err) {
      out.failed++;
      console.error(`[recurring] sweep item ${d.id} failed:`, err);
    }
  }
  return out;
}
