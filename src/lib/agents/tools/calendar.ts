import { z } from "zod";
import { query } from "@/lib/dsql";
import { registerTool } from "@/lib/agents/registry";
import type { ToolResult } from "@/lib/agents/types";
import {
  BOOKING_TYPE_COLS,
  BookingConflictError,
  BookingValidationError,
  availableSlots,
  cancelBooking,
  createBooking,
  describeInstant,
  ensureDefaultCalendar,
  getBooking,
  getBookingType,
  getBookingTypeBySlug,
  type BookingTypeRow,
} from "@/lib/calendar/booking";
import { groupSlotsByDay } from "@/lib/calendar/slots";

/** Calendar tools: propose slots, book, cancel. All scoped to ctx.userId (org data id). */

function fail(error: string): ToolResult {
  return { ok: false, summary: error, error };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function resolveType(dataId: string, ref?: string | null): Promise<BookingTypeRow | null> {
  if (ref) {
    return (await getBookingType(dataId, ref)) ?? (await getBookingTypeBySlug(dataId, ref));
  }
  const rows = await query<BookingTypeRow>(
    `SELECT ${BOOKING_TYPE_COLS} FROM booking_types WHERE user_id = $1 AND active = TRUE ORDER BY created_at ASC LIMIT 1`,
    [dataId]
  );
  return rows[0] ?? null;
}

/* ---------- calendar.propose_slots ---------- */
const ProposeInput = z.object({
  booking_type: z.string().max(120).optional().describe("Booking type id or slug; defaults to the first active type"),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type ProposeInputT = z.infer<typeof ProposeInput>;

registerTool<ProposeInputT>({
  name: "calendar.propose_slots",
  module: "calendar",
  description:
    "List open appointment times for a booking type within a date range (defaults to the next 7 days). Use before calendar.book so you only offer real availability.",
  input: ProposeInput,
  parameters: {
    type: "object",
    properties: {
      booking_type: { type: "string", description: "Booking type id or slug (optional; defaults to the first active one)" },
      from: { type: "string", description: "ISO start of the search window (optional, default now)" },
      to: { type: "string", description: "ISO end of the search window (optional, default from + 7 days)" },
      limit: { type: "number", description: "Max slots to return (default 12)" },
    },
  },
  scope: "read",
  preview: (i) => `Propose slots${i.booking_type ? ` for ${i.booking_type}` : ""}`,
  async run(ctx, input) {
    try {
      const type = await resolveType(ctx.userId, input.booking_type);
      if (!type) return fail("No booking type is set up yet. Ask the owner to create one under Calendar.");
      const now = new Date();
      const from = input.from ? new Date(input.from) : now;
      const to = input.to ? new Date(input.to) : new Date(from.getTime() + 7 * 86_400_000);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return fail("from/to must be ISO dates");
      const { timezone, slots } = await availableSlots(type, from, to, now);
      const limit = input.limit ?? 12;
      const picked = slots.slice(0, limit);
      const byDay = groupSlotsByDay(picked, timezone);
      return {
        ok: true,
        summary: `${picked.length} open slot${picked.length === 1 ? "" : "s"} for ${type.name} (${timezone})`,
        data: {
          bookingType: { id: type.id, slug: type.slug, name: type.name, durationMinutes: type.duration_minutes },
          timezone,
          slots: picked.map((iso) => ({ startsAt: iso, local: describeInstant(iso, timezone) })),
          byDay,
          totalAvailable: slots.length,
        },
      };
    } catch (err) {
      return fail(errMsg(err));
    }
  },
});

/* ---------- calendar.book ---------- */
const BookInput = z.object({
  starts_at: z.string().min(10).max(40),
  name: z.string().min(1).max(200),
  email: z.string().email().max(320).optional(),
  phone: z.string().max(40).optional(),
  booking_type: z.string().max(120).optional(),
  contact_id: z.string().max(80).optional(),
  notes: z.string().max(2000).optional(),
});
type BookInputT = z.infer<typeof BookInput>;

registerTool<BookInputT>({
  name: "calendar.book",
  module: "calendar",
  description: "Book an appointment at a slot returned by calendar.propose_slots. Sends the customer a confirmation with a cancel link.",
  input: BookInput,
  parameters: {
    type: "object",
    properties: {
      starts_at: { type: "string", description: "ISO start time from calendar.propose_slots" },
      name: { type: "string", description: "Customer name" },
      email: { type: "string", description: "Customer email (confirmation is sent here)" },
      phone: { type: "string" },
      booking_type: { type: "string", description: "Booking type id or slug (optional)" },
      contact_id: { type: "string", description: "Existing CRM contact id (optional)" },
      notes: { type: "string" },
    },
    required: ["starts_at", "name"],
  },
  scope: "write",
  requiresApproval: (_input, ctx) => ctx.autonomy !== "auto",
  preview: (i) => `Book ${i.name} at ${i.starts_at}${i.booking_type ? ` (${i.booking_type})` : ""}`,
  async run(ctx, input) {
    try {
      const type = await resolveType(ctx.userId, input.booking_type);
      await ensureDefaultCalendar(ctx.userId);
      const { booking } = await createBooking(ctx.userId, {
        bookingTypeId: type?.id ?? null,
        contactId: input.contact_id ?? null,
        name: input.name,
        email: input.email ?? null,
        phone: input.phone ?? null,
        startsAt: input.starts_at,
        notes: input.notes ?? null,
        source: "agent",
      });
      return {
        ok: true,
        summary: `Booked ${booking.name} for ${booking.starts_at}`,
        data: { id: booking.id, startsAt: booking.starts_at, endsAt: booking.ends_at, status: booking.status, contactId: booking.contact_id },
      };
    } catch (err) {
      if (err instanceof BookingConflictError) return fail("That time is no longer available; call calendar.propose_slots again.");
      if (err instanceof BookingValidationError) return fail(err.message);
      return fail(errMsg(err));
    }
  },
});

/* ---------- calendar.cancel_booking ---------- */
const CancelInput = z.object({
  booking_id: z.string().min(1).max(80),
  reason: z.string().max(500).optional(),
});
type CancelInputT = z.infer<typeof CancelInput>;

registerTool<CancelInputT>({
  name: "calendar.cancel_booking",
  module: "calendar",
  description: "Cancel an existing booking by id and notify the customer.",
  input: CancelInput,
  parameters: {
    type: "object",
    properties: {
      booking_id: { type: "string" },
      reason: { type: "string" },
    },
    required: ["booking_id"],
  },
  scope: "write",
  requiresApproval: true,
  preview: (i) => `Cancel booking ${i.booking_id}${i.reason ? `: ${i.reason}` : ""}`,
  async run(ctx, input) {
    try {
      const existing = await getBooking(ctx.userId, input.booking_id);
      if (!existing) return fail("Booking not found");
      const row = await cancelBooking(ctx.userId, input.booking_id, input.reason);
      return { ok: true, summary: `Cancelled booking for ${existing.name}`, data: { id: input.booking_id, status: row?.status ?? "cancelled" } };
    } catch (err) {
      return fail(errMsg(err));
    }
  },
});
