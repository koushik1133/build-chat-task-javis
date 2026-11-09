import { randomUUID } from "crypto";
import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { getStaff, staffNames, WorkforceError } from "./staff";
import { defaultLeaveHours, isValidYmd, LEAVE_KINDS, LEAVE_STATUSES, PAID_LEAVE_KINDS, remainingHours, type BalanceDTO, type LeaveDTO, type LeaveKind } from "./pure";

/**
 * Leave requests and balances. A request for a kind that has a balance row
 * must fit the remaining hours; approval debits the balance with a
 * conditional UPDATE (used + hours <= allotted) so two concurrent approvals
 * cannot overdraw it. Unpaid/other leave never needs a balance.
 */

export interface LeaveRow {
  id: string;
  user_id: string;
  staff_id: string;
  kind: string;
  starts_on: string;
  ends_on: string;
  hours: number;
  status: string;
  note: string | null;
  decided_by: string | null;
  decided_at: string | Date | null;
  created_at: string | Date;
}

export const LEAVE_COLS = `id, user_id, staff_id, kind, starts_on::text AS starts_on, ends_on::text AS ends_on, hours, status, note, decided_by, decided_at, created_at`;

const iso = (v: string | Date) => new Date(v).toISOString();

export function toLeaveDTO(r: LeaveRow, names?: Map<string, string>): LeaveDTO {
  return {
    id: r.id,
    staff_id: r.staff_id,
    staff_name: names?.get(r.staff_id) ?? null,
    kind: (LEAVE_KINDS as readonly string[]).includes(r.kind) ? (r.kind as LeaveKind) : "other",
    starts_on: r.starts_on.slice(0, 10),
    ends_on: r.ends_on.slice(0, 10),
    hours: Number(r.hours) || 0,
    status: (LEAVE_STATUSES as readonly string[]).includes(r.status) ? (r.status as LeaveDTO["status"]) : "pending",
    note: r.note,
    decided_by: r.decided_by,
    decided_at: r.decided_at ? iso(r.decided_at) : null,
    created_at: iso(r.created_at),
  };
}

const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

export const LeaveRequestSchema = z
  .object({
    staff_id: z.string().trim().min(1).max(100),
    kind: z.enum(LEAVE_KINDS).default("vacation"),
    starts_on: Ymd,
    ends_on: Ymd,
    /** Defaults to weekdays × daily hours from the staff profile. */
    hours: z.number().int().min(0).max(2000).optional(),
    note: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();
export type LeaveRequestInput = z.infer<typeof LeaveRequestSchema>;

export const LeaveDecisionSchema = z.object({ decision: z.enum(["approve", "reject", "cancel"]), note: z.string().trim().max(2000).nullable().optional() }).strict();

export const BalanceUpsertSchema = z
  .object({
    staff_id: z.string().trim().min(1).max(100),
    kind: z.enum(LEAVE_KINDS),
    year: z.number().int().min(2000).max(2100),
    allotted_hours: z.number().int().min(0).max(10_000),
  })
  .strict();

export interface ListLeaveOpts {
  status?: string | null;
  staffId?: string | null;
  from?: string | null;
  to?: string | null;
  limit?: number;
}

export async function listLeave(dataId: string, opts: ListLeaveOpts = {}): Promise<LeaveDTO[]> {
  const params: unknown[] = [dataId];
  const where = [`user_id = $1`];
  if (opts.status) {
    params.push(opts.status);
    where.push(`status = $${params.length}`);
  }
  if (opts.staffId) {
    params.push(opts.staffId);
    where.push(`staff_id = $${params.length}`);
  }
  if (isValidYmd(opts.from)) {
    params.push(opts.from);
    where.push(`ends_on >= $${params.length}`);
  }
  if (isValidYmd(opts.to)) {
    params.push(opts.to);
    where.push(`starts_on <= $${params.length}`);
  }
  params.push(Math.min(Math.max(opts.limit ?? 200, 1), 1000));
  const rows = await query<LeaveRow>(`SELECT ${LEAVE_COLS} FROM leave_requests WHERE ${where.join(" AND ")} ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, starts_on DESC, created_at DESC LIMIT $${params.length}`, params);
  const names = await staffNames(dataId, rows.map((r) => r.staff_id));
  return rows.map((r) => toLeaveDTO(r, names));
}

export async function getLeave(dataId: string, id: string): Promise<LeaveDTO | null> {
  const row = await queryOne<LeaveRow>(`SELECT ${LEAVE_COLS} FROM leave_requests WHERE user_id = $1 AND id = $2`, [dataId, id]);
  if (!row) return null;
  return toLeaveDTO(row, await staffNames(dataId, [row.staff_id]));
}

async function balanceRow(dataId: string, staffId: string, kind: string, year: number): Promise<{ allotted_hours: number; used_hours: number } | null> {
  return queryOne<{ allotted_hours: number; used_hours: number }>(`SELECT allotted_hours, used_hours FROM leave_balances WHERE user_id = $1 AND staff_id = $2 AND kind = $3 AND year = $4`, [dataId, staffId, kind, year]);
}

/** Hours already committed (pending + approved) against a balance year, excluding one request id. */
async function committedHours(dataId: string, staffId: string, kind: string, year: number, excludeId?: string): Promise<number> {
  const row = await queryOne<{ n: string }>(
    `SELECT COALESCE(SUM(hours), 0)::text AS n FROM leave_requests WHERE user_id = $1 AND staff_id = $2 AND kind = $3 AND status IN ('pending', 'approved') AND EXTRACT(YEAR FROM starts_on) = $4 AND id <> $5`,
    [dataId, staffId, kind, year, excludeId ?? ""]
  );
  return Number(row?.n ?? 0);
}

export async function requestLeave(dataId: string, input: LeaveRequestInput, actor?: string | null): Promise<LeaveDTO> {
  if (input.ends_on < input.starts_on) throw new WorkforceError(400, "ends_on must not be before starts_on");
  const staff = await getStaff(dataId, input.staff_id);
  if (!staff || !staff.active) throw new WorkforceError(400, "staff_id is not an active staff profile");
  const hours = input.hours ?? defaultLeaveHours(input.starts_on, input.ends_on, staff.weekly_hours);
  const year = Number(input.starts_on.slice(0, 4));
  if (PAID_LEAVE_KINDS.includes(input.kind)) {
    const bal = await balanceRow(dataId, input.staff_id, input.kind, year);
    if (bal) {
      const committed = await committedHours(dataId, input.staff_id, input.kind, year);
      const remaining = Number(bal.allotted_hours) - committed;
      if (hours > remaining) throw new WorkforceError(409, `Only ${Math.max(0, remaining)}h of ${input.kind} remain for ${year} (${committed}h already requested or approved).`, { remaining_hours: Math.max(0, remaining), requested_hours: hours });
    }
  }
  const overlap = await queryOne<{ id: string }>(
    `SELECT id FROM leave_requests WHERE user_id = $1 AND staff_id = $2 AND status IN ('pending', 'approved') AND starts_on <= $4 AND ends_on >= $3 LIMIT 1`,
    [dataId, input.staff_id, input.starts_on, input.ends_on]
  );
  if (overlap) throw new WorkforceError(409, "This person already has leave requested for those dates", { leave_id: overlap.id });
  const id = randomUUID();
  await query(`INSERT INTO leave_requests (id, user_id, staff_id, kind, starts_on, ends_on, hours, status, note) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)`, [id, dataId, input.staff_id, input.kind, input.starts_on, input.ends_on, hours, input.note ?? null]);
  await emitEvent(dataId, { type: "leave.requested", entity: "leave_request", entityId: id, data: { staff_id: input.staff_id, kind: input.kind, starts_on: input.starts_on, ends_on: input.ends_on, hours, actor: actor ?? null } });
  await enqueueNotification(dataId, {
    channel: "in_app",
    recipient: dataId,
    subject: `Leave request: ${staff.display_name}`,
    body: `${staff.display_name} requested ${hours}h ${input.kind} leave ${input.starts_on}${input.ends_on !== input.starts_on ? ` to ${input.ends_on}` : ""}.`,
    data: { kind: "leave.requested", leaveId: id, href: "/workforce?tab=leave" },
  }).catch(() => undefined);
  const created = await getLeave(dataId, id);
  if (!created) throw new WorkforceError(500, "leave request not found after insert");
  return created;
}

/**
 * approve: debit the balance (race-safe) then flip pending → approved.
 * reject: flip pending → rejected. cancel: pending → cancelled, or approved → cancelled with the balance credited back.
 */
export async function decideLeave(dataId: string, id: string, decision: "approve" | "reject" | "cancel", actor: string | null, note?: string | null): Promise<LeaveDTO> {
  const current = await getLeave(dataId, id);
  if (!current) throw new WorkforceError(404, "Leave request not found");
  const year = Number(current.starts_on.slice(0, 4));
  const tracked = PAID_LEAVE_KINDS.includes(current.kind);

  if (decision === "approve") {
    if (current.status !== "pending") throw new WorkforceError(409, `Request is already ${current.status}`);
    if (tracked) {
      const bal = await balanceRow(dataId, current.staff_id, current.kind, year);
      if (bal) {
        const debited = await query<{ used_hours: number }>(
          `UPDATE leave_balances SET used_hours = used_hours + $5 WHERE user_id = $1 AND staff_id = $2 AND kind = $3 AND year = $4 AND used_hours + $5 <= allotted_hours RETURNING used_hours`,
          [dataId, current.staff_id, current.kind, year, current.hours]
        );
        if (debited.length === 0) throw new WorkforceError(409, `Not enough ${current.kind} balance left for ${year} (${remainingHours(bal)}h remaining, ${current.hours}h requested).`, { remaining_hours: remainingHours(bal), requested_hours: current.hours });
      }
    }
    const flipped = await query<{ id: string }>(`UPDATE leave_requests SET status = 'approved', decided_by = $3, decided_at = NOW(), note = COALESCE($4, note) WHERE user_id = $1 AND id = $2 AND status = 'pending' RETURNING id`, [dataId, id, actor, note ?? null]);
    if (flipped.length === 0) {
      // Lost the race: give the hours back.
      if (tracked) await query(`UPDATE leave_balances SET used_hours = GREATEST(0, used_hours - $5) WHERE user_id = $1 AND staff_id = $2 AND kind = $3 AND year = $4`, [dataId, current.staff_id, current.kind, year, current.hours]).catch(() => undefined);
      throw new WorkforceError(409, "Request was decided concurrently");
    }
  } else if (decision === "reject") {
    const flipped = await query<{ id: string }>(`UPDATE leave_requests SET status = 'rejected', decided_by = $3, decided_at = NOW(), note = COALESCE($4, note) WHERE user_id = $1 AND id = $2 AND status = 'pending' RETURNING id`, [dataId, id, actor, note ?? null]);
    if (flipped.length === 0) throw new WorkforceError(409, `Request is already ${current.status}`);
  } else {
    if (current.status !== "pending" && current.status !== "approved") throw new WorkforceError(409, `Request is already ${current.status}`);
    const flipped = await query<{ id: string; was: string }>(
      `UPDATE leave_requests SET status = 'cancelled', decided_by = $3, decided_at = NOW() WHERE user_id = $1 AND id = $2 AND status IN ('pending', 'approved') RETURNING id, $4::text AS was`,
      [dataId, id, actor, current.status]
    );
    if (flipped.length === 0) throw new WorkforceError(409, "Request was decided concurrently");
    if (current.status === "approved" && tracked) {
      await query(`UPDATE leave_balances SET used_hours = GREATEST(0, used_hours - $5) WHERE user_id = $1 AND staff_id = $2 AND kind = $3 AND year = $4`, [dataId, current.staff_id, current.kind, year, current.hours]).catch(() => undefined);
    }
  }
  await emitEvent(dataId, { type: "leave.decided", entity: "leave_request", entityId: id, data: { staff_id: current.staff_id, kind: current.kind, decision, hours: current.hours, actor } });
  const staff = await getStaff(dataId, current.staff_id);
  if (staff?.email && decision !== "cancel") {
    await enqueueNotification(dataId, {
      channel: "email",
      recipient: staff.email,
      subject: `Your ${current.kind} leave request was ${decision === "approve" ? "approved" : "declined"}`,
      body: `Hi ${staff.display_name},\n\nYour ${current.kind} leave for ${current.starts_on}${current.ends_on !== current.starts_on ? ` to ${current.ends_on}` : ""} (${current.hours}h) was ${decision === "approve" ? "approved" : "declined"}.${note ? `\n\nNote: ${note}` : ""}\n`,
      data: { kind: "leave.decided", leaveId: id, decision },
    }).catch(() => undefined);
  }
  const updated = await getLeave(dataId, id);
  if (!updated) throw new WorkforceError(404, "Leave request not found");
  return updated;
}

/* ─── balances ─────────────────────────────────────────────────────────── */

export async function listBalances(dataId: string, opts: { year?: number | null; staffId?: string | null } = {}): Promise<BalanceDTO[]> {
  const params: unknown[] = [dataId];
  const where = [`user_id = $1`];
  if (opts.year) {
    params.push(opts.year);
    where.push(`year = $${params.length}`);
  }
  if (opts.staffId) {
    params.push(opts.staffId);
    where.push(`staff_id = $${params.length}`);
  }
  const rows = await query<{ staff_id: string; kind: string; year: number; allotted_hours: number; used_hours: number }>(
    `SELECT staff_id, kind, year, allotted_hours, used_hours FROM leave_balances WHERE ${where.join(" AND ")} ORDER BY year DESC, staff_id, kind LIMIT 2000`,
    params
  );
  const names = await staffNames(dataId, rows.map((r) => r.staff_id));
  return rows.map((r) => ({
    staff_id: r.staff_id,
    staff_name: names.get(r.staff_id) ?? null,
    kind: (LEAVE_KINDS as readonly string[]).includes(r.kind) ? (r.kind as LeaveKind) : "other",
    year: Number(r.year),
    allotted_hours: Number(r.allotted_hours),
    used_hours: Number(r.used_hours),
    remaining_hours: remainingHours(r),
  }));
}

/** Set the allotment for a staff/kind/year. Used hours are preserved (and recomputed from approved requests when the row is new). */
export async function upsertBalance(dataId: string, input: z.infer<typeof BalanceUpsertSchema>): Promise<BalanceDTO> {
  const staff = await getStaff(dataId, input.staff_id);
  if (!staff) throw new WorkforceError(400, "staff_id is not a staff profile");
  const existing = await balanceRow(dataId, input.staff_id, input.kind, input.year);
  if (existing) {
    await query(`UPDATE leave_balances SET allotted_hours = $5 WHERE user_id = $1 AND staff_id = $2 AND kind = $3 AND year = $4`, [dataId, input.staff_id, input.kind, input.year, input.allotted_hours]);
  } else {
    const used = await queryOne<{ n: string }>(
      `SELECT COALESCE(SUM(hours), 0)::text AS n FROM leave_requests WHERE user_id = $1 AND staff_id = $2 AND kind = $3 AND status = 'approved' AND EXTRACT(YEAR FROM starts_on) = $4`,
      [dataId, input.staff_id, input.kind, input.year]
    );
    await query(`INSERT INTO leave_balances (user_id, staff_id, kind, year, allotted_hours, used_hours) VALUES ($1, $2, $3, $4, $5, $6)`, [dataId, input.staff_id, input.kind, input.year, input.allotted_hours, Number(used?.n ?? 0)]);
  }
  const rows = await listBalances(dataId, { year: input.year, staffId: input.staff_id });
  const row = rows.find((r) => r.kind === input.kind);
  if (!row) throw new WorkforceError(500, "balance not found after upsert");
  return row;
}

/** Approved leave hours per staff in an inclusive Y-M-D range, split paid/unpaid. Requests straddling the range are pro-rated by weekday. */
export async function approvedLeaveHours(dataId: string, from: string, to: string): Promise<Map<string, { paid: number; unpaid: number }>> {
  const rows = await query<LeaveRow>(`SELECT ${LEAVE_COLS} FROM leave_requests WHERE user_id = $1 AND status = 'approved' AND ends_on >= $2 AND starts_on <= $3 LIMIT 5000`, [dataId, from, to]);
  const out = new Map<string, { paid: number; unpaid: number }>();
  for (const r of rows) {
    const total = defaultLeaveHours(r.starts_on.slice(0, 10), r.ends_on.slice(0, 10), 40) || 1; // weekday weighting only
    const inRange = defaultLeaveHours(r.starts_on.slice(0, 10) > from ? r.starts_on.slice(0, 10) : from, r.ends_on.slice(0, 10) < to ? r.ends_on.slice(0, 10) : to, 40);
    const share = Math.min(1, inRange / total);
    const hours = Math.round(Number(r.hours) * share * 100) / 100;
    const cur = out.get(r.staff_id) ?? { paid: 0, unpaid: 0 };
    if (PAID_LEAVE_KINDS.includes(r.kind as LeaveKind)) cur.paid += hours;
    else cur.unpaid += hours;
    out.set(r.staff_id, cur);
  }
  return out;
}
