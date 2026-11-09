import { z } from "zod";
import { query } from "@/lib/dsql";
import { registerTool } from "@/lib/agents/registry";
import type { ToolResult } from "@/lib/agents/types";
import { orgTimezone } from "@/lib/calendar/booking";
import { listLeave } from "@/lib/workforce/leave";
import { addDays, isValidYmd, localDate, localMidnightUtc, LEAVE_STATUSES } from "@/lib/workforce/pure";
import { createShift, listShifts } from "@/lib/workforce/shifts";
import { listStaff, WorkforceError } from "@/lib/workforce/staff";

/** Workforce tools: schedule gaps (read), create shift (write, approval), leave requests (read). Scoped to ctx.userId (org data id). */

function fail(error: string, data?: unknown): ToolResult {
  return { ok: false, summary: error, error, data };
}

/* ---------- workforce.schedule_gaps ---------- */
const GapsInput = z.object({
  from: z.string().max(10).optional().describe("YYYY-MM-DD, default today"),
  days: z.number().int().min(1).max(14).optional().describe("Days to scan (default 7)"),
});
type GapsInputT = z.infer<typeof GapsInput>;

registerTool<GapsInputT>({
  name: "workforce.schedule_gaps",
  module: "workforce",
  description:
    "Find staffing gaps: days with confirmed bookings but no published shift covering them, open (unassigned) shifts, and who is free that day (active staff not on approved leave and not already scheduled). Use before workforce.create_shift.",
  input: GapsInput,
  parameters: {
    type: "object",
    properties: {
      from: { type: "string", description: "YYYY-MM-DD start day (default today)" },
      days: { type: "number", description: "How many days to scan, 1–14 (default 7)" },
    },
  },
  scope: "read",
  preview: (i) => `Schedule gaps from ${i.from ?? "today"} for ${i.days ?? 7} days`,
  async run(ctx, input) {
    try {
      const tz = await orgTimezone(ctx.userId);
      const start = isValidYmd(input.from) ? input.from : localDate(new Date(), tz);
      const days = input.days ?? 7;
      const fromIso = localMidnightUtc(start, tz).toISOString();
      const toIso = localMidnightUtc(addDays(start, days), tz).toISOString();
      const [staff, shifts, bookings, leave] = await Promise.all([
        listStaff(ctx.userId),
        listShifts(ctx.userId, { from: fromIso, to: toIso, limit: 2000 }),
        query<{ id: string; name: string; starts_at: string | Date; ends_at: string | Date }>(
          `SELECT id, name, starts_at, ends_at FROM bookings WHERE user_id = $1 AND status = 'confirmed' AND starts_at >= $2 AND starts_at < $3 ORDER BY starts_at ASC LIMIT 500`,
          [ctx.userId, fromIso, toIso]
        ).catch(() => []),
        listLeave(ctx.userId, { status: "approved", from: start, to: addDays(start, days - 1), limit: 500 }),
      ]);
      const out: Array<{ day: string; bookings: number; uncovered_bookings: number; published_shifts: number; open_shifts: number; available_staff: Array<{ id: string; name: string; role_title: string | null }> }> = [];
      for (let i = 0; i < days; i++) {
        const day = addDays(start, i);
        const dayShifts = shifts.filter((s) => localDate(s.starts_at, tz) === day && s.status !== "cancelled");
        const live = dayShifts.filter((s) => s.status !== "draft" && s.staff_id);
        const dayBookings = bookings.filter((b) => localDate(new Date(b.starts_at).toISOString(), tz) === day);
        const uncovered = dayBookings.filter((b) => {
          const bs = new Date(b.starts_at).getTime();
          const be = new Date(b.ends_at).getTime();
          return !live.some((s) => new Date(s.starts_at).getTime() < be && new Date(s.ends_at).getTime() > bs);
        });
        const onLeave = new Set(leave.filter((l) => l.starts_on <= day && l.ends_on >= day).map((l) => l.staff_id));
        const scheduled = new Set(dayShifts.map((s) => s.staff_id).filter(Boolean));
        const available = staff.filter((s) => !onLeave.has(s.id) && !scheduled.has(s.id)).map((s) => ({ id: s.id, name: s.display_name, role_title: s.role_title }));
        out.push({ day, bookings: dayBookings.length, uncovered_bookings: uncovered.length, published_shifts: live.length, open_shifts: dayShifts.filter((s) => !s.staff_id).length, available_staff: available });
      }
      const gapDays = out.filter((d) => d.uncovered_bookings > 0 || d.open_shifts > 0);
      return {
        ok: true,
        summary: gapDays.length === 0 ? `No staffing gaps between ${start} and ${addDays(start, days - 1)}.` : `${gapDays.length} day${gapDays.length === 1 ? "" : "s"} with gaps: ${gapDays.map((d) => `${d.day} (${d.uncovered_bookings} uncovered booking${d.uncovered_bookings === 1 ? "" : "s"}, ${d.open_shifts} open shift${d.open_shifts === 1 ? "" : "s"})`).join("; ")}`,
        data: { timezone: tz, from: start, days: out, staffCount: staff.length },
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

/* ---------- workforce.create_shift ---------- */
const CreateShiftInput = z.object({
  staff_id: z.string().max(100).nullable().optional().describe("Staff profile id; omit for an open shift"),
  starts_at: z.string().min(10).max(40).describe("ISO start"),
  ends_at: z.string().min(10).max(40).describe("ISO end"),
  role_title: z.string().max(80).optional(),
  location: z.string().max(120).optional(),
  notes: z.string().max(2000).optional(),
  break_minutes: z.number().int().min(0).max(600).optional(),
  publish: z.boolean().optional().describe("Publish immediately (notifies the person)"),
});
type CreateShiftInputT = z.infer<typeof CreateShiftInput>;

registerTool<CreateShiftInputT>({
  name: "workforce.create_shift",
  module: "workforce",
  description: "Create a shift on the rota (draft unless publish=true). Fails with the conflict details when the person is double-booked or on approved leave.",
  input: CreateShiftInput,
  parameters: {
    type: "object",
    properties: {
      staff_id: { type: "string", description: "Staff profile id (optional; omit for an open shift)" },
      starts_at: { type: "string", description: "ISO start" },
      ends_at: { type: "string", description: "ISO end" },
      role_title: { type: "string" },
      location: { type: "string" },
      notes: { type: "string" },
      break_minutes: { type: "number" },
      publish: { type: "boolean", description: "Publish immediately and notify the person" },
    },
    required: ["starts_at", "ends_at"],
  },
  scope: "write",
  requiresApproval: true,
  preview: (i) => `Create ${i.publish ? "published " : ""}shift ${i.starts_at} → ${i.ends_at}${i.staff_id ? ` for ${i.staff_id}` : " (open)"}`,
  async run(ctx, input) {
    try {
      const startsAt = new Date(input.starts_at);
      const endsAt = new Date(input.ends_at);
      if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) return fail("starts_at/ends_at must be ISO dates");
      const shift = await createShift(ctx.userId, {
        staff_id: input.staff_id ?? null,
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        role_title: input.role_title ?? null,
        location: input.location ?? null,
        notes: input.notes ?? null,
        break_minutes: input.break_minutes ?? 0,
        publish: input.publish,
      });
      return { ok: true, summary: `Shift ${shift.id} created (${shift.status})${shift.staff_name ? ` for ${shift.staff_name}` : ""}: ${shift.starts_at} → ${shift.ends_at}`, data: shift };
    } catch (err) {
      if (err instanceof WorkforceError) return fail(err.message, err.details);
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

/* ---------- workforce.leave_requests ---------- */
const LeaveInput = z.object({
  status: z.enum(LEAVE_STATUSES).optional().describe("Default pending"),
  staff_id: z.string().max(100).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
type LeaveInputT = z.infer<typeof LeaveInput>;

registerTool<LeaveInputT>({
  name: "workforce.leave_requests",
  module: "workforce",
  description: "List leave requests (pending by default) with the person, kind, dates and hours. Read-only: approvals are made by a manager in Workforce → Leave.",
  input: LeaveInput,
  parameters: {
    type: "object",
    properties: {
      status: { type: "string", enum: [...LEAVE_STATUSES], description: "pending (default), approved, rejected or cancelled" },
      staff_id: { type: "string" },
      limit: { type: "number" },
    },
  },
  scope: "read",
  preview: (i) => `List ${i.status ?? "pending"} leave requests`,
  async run(ctx, input) {
    try {
      const status = input.status ?? "pending";
      const leave = await listLeave(ctx.userId, { status, staffId: input.staff_id ?? null, limit: input.limit ?? 50 });
      return {
        ok: true,
        summary: leave.length === 0 ? `No ${status} leave requests.` : `${leave.length} ${status} leave request${leave.length === 1 ? "" : "s"}: ${leave.slice(0, 5).map((l) => `${l.staff_name ?? l.staff_id} ${l.kind} ${l.starts_on}${l.ends_on !== l.starts_on ? `–${l.ends_on}` : ""} (${l.hours}h)`).join("; ")}${leave.length > 5 ? "…" : ""}`,
        data: { leave },
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});
