import { createHash, randomBytes, randomUUID } from "crypto";
import { query, queryOne, transaction } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { listSlots, wouldClash, zonedParts, type AvailabilityRule, type Interval } from "@/lib/calendar/slots";
import { keysetClause, type Cursor } from "@/lib/public-api/pagination";

/**
 * Booking domain: calendars, availability, booking types, bookings.
 *
 * All rows live under the org data id (`user_id`). Slot maths is in
 * `./slots.ts`; this module only loads rows, re-checks clashes inside a
 * transaction, and fans out notifications/events.
 */

export class BookingConflictError extends Error {
  constructor(message = "That time is no longer available.") {
    super(message);
    this.name = "BookingConflictError";
  }
}

export class BookingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookingValidationError";
  }
}

export interface CalendarRow {
  id: string;
  user_id: string;
  name: string;
  timezone: string;
  color: string | null;
  created_at: string;
}

export interface RuleRow extends AvailabilityRule {
  id: string;
  calendar_id: string;
}

export interface BookingTypeRow {
  id: string;
  user_id: string;
  calendar_id: string;
  slug: string;
  name: string;
  description: string | null;
  duration_minutes: number;
  buffer_before: number;
  buffer_after: number;
  min_notice_minutes: number;
  max_days_ahead: number;
  price_minor: number | null;
  currency: string | null;
  active: boolean;
  created_at: string;
}

export type BookingStatus = "confirmed" | "cancelled" | "completed" | "no_show";
export type BookingSource = "manual" | "public" | "agent" | "portal";

export interface BookingRow {
  id: string;
  user_id: string;
  calendar_id: string;
  booking_type_id: string | null;
  contact_id: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  starts_at: string;
  ends_at: string;
  status: BookingStatus;
  notes: string | null;
  source: BookingSource;
  created_at: string;
  updated_at: string;
}

export const BOOKING_COLS =
  "id, user_id, calendar_id, booking_type_id, contact_id, name, email, phone, starts_at, ends_at, status, notes, source, created_at, updated_at";

export const BOOKING_TYPE_COLS =
  "id, user_id, calendar_id, slug, name, description, duration_minutes, buffer_before, buffer_after, min_notice_minutes, max_days_ahead, price_minor, currency, active, created_at";

const MS_PER_MIN = 60_000;

export function hashCancelToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Timezone from organizations.settings JSON, falling back to UTC. */
export async function orgTimezone(dataId: string): Promise<string> {
  try {
    const org = await queryOne<{ settings: string | null }>(
      `SELECT settings FROM organizations WHERE owner_user_id = $1`,
      [dataId]
    );
    if (org?.settings) {
      const parsed: unknown = JSON.parse(org.settings);
      const tz = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).timezone : null;
      if (typeof tz === "string" && isValidTimezone(tz)) return tz;
    }
  } catch {
    // fall through
  }
  return "UTC";
}

/** First calendar for the org, created with Mon–Fri 9–17 rules when missing. */
export async function ensureDefaultCalendar(dataId: string): Promise<CalendarRow> {
  const existing = await queryOne<CalendarRow>(
    `SELECT id, user_id, name, timezone, color, created_at FROM calendars WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1`,
    [dataId]
  );
  if (existing) return existing;

  const id = randomUUID();
  const timezone = await orgTimezone(dataId);
  await query(
    `INSERT INTO calendars (id, user_id, name, timezone, color) VALUES ($1, $2, 'Main calendar', $3, '#6366f1')`,
    [id, dataId, timezone]
  );
  for (const weekday of [1, 2, 3, 4, 5]) {
    await query(
      `INSERT INTO availability_rules (id, calendar_id, weekday, start_minute, end_minute) VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), id, weekday, 9 * 60, 17 * 60]
    );
  }
  const row = await queryOne<CalendarRow>(
    `SELECT id, user_id, name, timezone, color, created_at FROM calendars WHERE id = $1`,
    [id]
  );
  if (!row) throw new Error("calendar creation failed");
  return row;
}

export async function listRules(calendarId: string): Promise<RuleRow[]> {
  return query<RuleRow>(
    `SELECT id, calendar_id, weekday, start_minute, end_minute FROM availability_rules WHERE calendar_id = $1 ORDER BY weekday, start_minute`,
    [calendarId]
  );
}

/** Replace the full weekly rule set for a calendar. */
export async function replaceRules(
  calendarId: string,
  rules: Array<{ weekday: number; start_minute: number; end_minute: number }>
): Promise<RuleRow[]> {
  for (const r of rules) {
    if (!Number.isInteger(r.weekday) || r.weekday < 0 || r.weekday > 6) throw new BookingValidationError("weekday must be 0-6");
    if (!Number.isInteger(r.start_minute) || !Number.isInteger(r.end_minute) || r.start_minute < 0 || r.end_minute > 1440 || r.end_minute <= r.start_minute) {
      throw new BookingValidationError("rule minutes must satisfy 0 <= start < end <= 1440");
    }
  }
  await transaction(async (client) => {
    await client.query(`DELETE FROM availability_rules WHERE calendar_id = $1`, [calendarId]);
    for (const r of rules) {
      await client.query(
        `INSERT INTO availability_rules (id, calendar_id, weekday, start_minute, end_minute) VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), calendarId, r.weekday, r.start_minute, r.end_minute]
      );
    }
  });
  return listRules(calendarId);
}

export async function getBookingType(dataId: string, id: string): Promise<BookingTypeRow | null> {
  return queryOne<BookingTypeRow>(`SELECT ${BOOKING_TYPE_COLS} FROM booking_types WHERE user_id = $1 AND id = $2`, [dataId, id]);
}

export async function getBookingTypeBySlug(dataId: string, slug: string): Promise<BookingTypeRow | null> {
  return queryOne<BookingTypeRow>(`SELECT ${BOOKING_TYPE_COLS} FROM booking_types WHERE user_id = $1 AND slug = $2`, [dataId, slug]);
}

/** Resolve an org by its public slug → data id. */
export async function resolveOrgBySlug(orgSlug: string): Promise<{ dataId: string; name: string; slug: string } | null> {
  const org = await queryOne<{ owner_user_id: string; name: string; slug: string }>(
    `SELECT owner_user_id, name, slug FROM organizations WHERE slug = $1`,
    [orgSlug]
  );
  return org ? { dataId: org.owner_user_id, name: org.name, slug: org.slug } : null;
}

/* ---------- availability ---------- */

async function busyIntervals(calendarId: string, from: Date, to: Date): Promise<{ existing: Interval[]; blocks: Interval[] }> {
  const pad = 24 * 60 * MS_PER_MIN; // buffers never exceed a day
  const lo = new Date(from.getTime() - pad).toISOString();
  const hi = new Date(to.getTime() + pad).toISOString();
  const [b, k] = await Promise.all([
    query<{ starts_at: string; ends_at: string }>(
      `SELECT starts_at, ends_at FROM bookings WHERE calendar_id = $1 AND status = 'confirmed' AND starts_at < $3 AND ends_at > $2`,
      [calendarId, lo, hi]
    ),
    query<{ starts_at: string; ends_at: string }>(
      `SELECT starts_at, ends_at FROM calendar_blocks WHERE calendar_id = $1 AND starts_at < $3 AND ends_at > $2`,
      [calendarId, lo, hi]
    ),
  ]);
  const toI = (r: { starts_at: string; ends_at: string }): Interval => ({ start: new Date(r.starts_at), end: new Date(r.ends_at) });
  return { existing: b.map(toI), blocks: k.map(toI) };
}

export async function availableSlots(
  type: BookingTypeRow,
  from: Date,
  to: Date,
  now = new Date()
): Promise<{ timezone: string; slots: string[] }> {
  const cal = await queryOne<{ timezone: string }>(`SELECT timezone FROM calendars WHERE id = $1`, [type.calendar_id]);
  const timezone = cal?.timezone ?? "UTC";
  const [rules, busy] = await Promise.all([listRules(type.calendar_id), busyIntervals(type.calendar_id, from, to)]);
  const slots = listSlots({ rules, existing: busy.existing, blocks: busy.blocks, type, from, to, now, timezone });
  return { timezone, slots };
}

/* ---------- create / cancel ---------- */

export interface CreateBookingInput {
  calendarId?: string;
  bookingTypeId?: string | null;
  contactId?: string | null;
  name: string;
  email?: string | null;
  phone?: string | null;
  startsAt: string | Date;
  /** Required when no booking type is given. */
  durationMinutes?: number;
  notes?: string | null;
  source: BookingSource;
  /** Skip availability-rule checks (manual/agent bookings may sit outside hours). */
  ignoreRules?: boolean;
}

export interface CreatedBooking {
  booking: BookingRow;
  /** Plain cancel token — shown once to the customer. */
  cancelToken: string;
}

function fmtWhen(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** Find an existing contact by email/phone, or create one. Returns the id. */
async function upsertContact(dataId: string, input: { name: string; email?: string | null; phone?: string | null }): Promise<string | null> {
  try {
    const email = input.email?.trim().toLowerCase() || null;
    const phone = input.phone?.trim() || null;
    if (!email && !phone) return null;
    const existing = await queryOne<{ id: string }>(
      `SELECT id FROM crm_contacts WHERE user_id = $1 AND ((($2::text IS NOT NULL) AND LOWER(email) = $2) OR (($3::text IS NOT NULL) AND phone = $3)) LIMIT 1`,
      [dataId, email, phone]
    );
    if (existing) return existing.id;
    const id = randomUUID();
    await query(
      `INSERT INTO crm_contacts (id, user_id, domain, full_name, email, phone, tags, lifecycle, notes, last_contact)
       VALUES ($1, $2, 'general', $3, $4, $5, '["booking"]', 'lead', NULL, NOW())`,
      [id, dataId, input.name.trim().slice(0, 200), email, phone]
    );
    await emitEvent(dataId, { type: "crm.contact.created", entity: "contact", entityId: id, data: { source: "booking" } });
    return id;
  } catch (err) {
    console.error("[booking] contact upsert failed:", err);
    return null;
  }
}

export async function createBooking(dataId: string, input: CreateBookingInput): Promise<CreatedBooking> {
  const name = input.name?.trim();
  if (!name) throw new BookingValidationError("name is required");
  const start = new Date(input.startsAt);
  if (Number.isNaN(start.getTime())) throw new BookingValidationError("startsAt must be a valid date");

  let type: BookingTypeRow | null = null;
  if (input.bookingTypeId) {
    type = await getBookingType(dataId, input.bookingTypeId);
    if (!type) throw new BookingValidationError("unknown booking type");
    if (!type.active && input.source === "public") throw new BookingValidationError("booking type is not active");
  }
  const calendarId = type?.calendar_id ?? input.calendarId ?? (await ensureDefaultCalendar(dataId)).id;
  const cal = await queryOne<CalendarRow>(
    `SELECT id, user_id, name, timezone, color, created_at FROM calendars WHERE id = $1 AND user_id = $2`,
    [calendarId, dataId]
  );
  if (!cal) throw new BookingValidationError("unknown calendar");

  const duration = type?.duration_minutes ?? input.durationMinutes ?? 30;
  if (!Number.isFinite(duration) || duration < 5 || duration > 24 * 60) throw new BookingValidationError("invalid duration");
  const end = new Date(start.getTime() + duration * MS_PER_MIN);
  const buffers = { before: type?.buffer_before ?? 0, after: type?.buffer_after ?? 0 };

  // Rule/notice/horizon check for public + portal + agent bookings.
  if (!input.ignoreRules) {
    const t = type ?? { duration_minutes: duration, buffer_before: 0, buffer_after: 0, min_notice_minutes: 0, max_days_ahead: 365 };
    const rules = await listRules(calendarId);
    const { existing, blocks } = await busyIntervals(calendarId, start, end);
    const slots = listSlots({
      rules,
      existing,
      blocks,
      type: t,
      from: new Date(start.getTime() - 1),
      to: new Date(end.getTime() + 1),
      now: new Date(),
      timezone: cal.timezone,
    });
    if (!slots.includes(start.toISOString())) throw new BookingConflictError();
  }

  const contactId = input.contactId ?? (await upsertContact(dataId, input));
  const id = randomUUID();
  const cancelToken = randomBytes(24).toString("base64url");

  await transaction(async (client) => {
    const lo = new Date(start.getTime() - 24 * 60 * MS_PER_MIN).toISOString();
    const hi = new Date(end.getTime() + 24 * 60 * MS_PER_MIN).toISOString();
    const rows = await client.query<{ starts_at: string; ends_at: string }>(
      `SELECT starts_at, ends_at FROM bookings WHERE calendar_id = $1 AND status = 'confirmed' AND starts_at < $3 AND ends_at > $2`,
      [calendarId, lo, hi]
    );
    const blocks = await client.query<{ starts_at: string; ends_at: string }>(
      `SELECT starts_at, ends_at FROM calendar_blocks WHERE calendar_id = $1 AND starts_at < $3 AND ends_at > $2`,
      [calendarId, lo, hi]
    );
    const busy: Interval[] = [...rows.rows, ...blocks.rows].map((r) => ({ start: new Date(r.starts_at), end: new Date(r.ends_at) }));
    if (wouldClash({ start, end }, busy, buffers)) throw new BookingConflictError();
    await client.query(
      `INSERT INTO bookings (id, user_id, calendar_id, booking_type_id, contact_id, name, email, phone, starts_at, ends_at, status, notes, source, cancel_token_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'confirmed', $11, $12, $13)`,
      [
        id,
        dataId,
        calendarId,
        type?.id ?? null,
        contactId,
        name.slice(0, 200),
        input.email?.trim().toLowerCase().slice(0, 320) || null,
        input.phone?.trim().slice(0, 40) || null,
        start.toISOString(),
        end.toISOString(),
        input.notes?.trim().slice(0, 2000) || null,
        input.source,
        hashCancelToken(cancelToken),
      ]
    );
  });

  const booking = await queryOne<BookingRow>(`SELECT ${BOOKING_COLS} FROM bookings WHERE id = $1`, [id]);
  if (!booking) throw new Error("booking insert failed");

  const when = fmtWhen(booking.starts_at, cal.timezone);
  const label = type?.name ?? "Appointment";
  const cancelUrl = `${(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}/book/cancel/${cancelToken}`;

  try {
    if (booking.email) {
      await enqueueNotification(dataId, {
        channel: "email",
        recipient: booking.email,
        subject: `Confirmed: ${label} on ${when}`,
        body: `Hi ${booking.name},\n\nYour ${label} is confirmed for ${when} (${duration} min).\n\nNeed to cancel? ${cancelUrl}\n`,
        data: { bookingId: id, kind: "booking.confirmation" },
      });
    }
    await enqueueNotification(dataId, {
      channel: "in_app",
      recipient: dataId,
      subject: `New booking: ${booking.name}`,
      body: `${label} with ${booking.name} on ${when} (${booking.source}).`,
      data: { bookingId: id, kind: "booking.created", href: "/calendar" },
    });
  } catch (err) {
    console.error("[booking] notification enqueue failed:", err);
  }

  await emitEvent(dataId, {
    type: "booking.created",
    entity: "booking",
    entityId: id,
    data: { name: booking.name, email: booking.email, startsAt: booking.starts_at, endsAt: booking.ends_at, bookingTypeId: type?.id ?? null, source: booking.source, contactId },
  });

  return { booking, cancelToken };
}

export async function getBooking(dataId: string, id: string): Promise<BookingRow | null> {
  return queryOne<BookingRow>(`SELECT ${BOOKING_COLS} FROM bookings WHERE user_id = $1 AND id = $2`, [dataId, id]);
}

export interface ListBookingsOptions {
  /** Bookings starting at/after this instant. */
  from?: Date | null;
  /** Bookings starting before this instant. */
  to?: Date | null;
  status?: BookingStatus | null;
  limit?: number;
  /** Newest first (created_at DESC, id DESC) — cursor-friendly. */
  cursor?: Cursor | null;
}

/** Newest-first listing for the public API (the calendar UI queries by range in its own route). */
export async function listBookings(dataId: string, opts: ListBookingsOptions = {}): Promise<BookingRow[]> {
  const params: unknown[] = [dataId];
  let sql = `SELECT ${BOOKING_COLS} FROM bookings WHERE user_id = $1`;
  if (opts.from) {
    params.push(opts.from.toISOString());
    sql += ` AND starts_at >= $${params.length}`;
  }
  if (opts.to) {
    params.push(opts.to.toISOString());
    sql += ` AND starts_at < $${params.length}`;
  }
  if (opts.status) {
    params.push(opts.status);
    sql += ` AND status = $${params.length}`;
  }
  sql += keysetClause(opts.cursor, params);
  params.push(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  sql += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}`;
  return query<BookingRow>(sql, params);
}

export async function listBookingTypes(dataId: string, opts: { activeOnly?: boolean } = {}): Promise<BookingTypeRow[]> {
  return query<BookingTypeRow>(
    `SELECT ${BOOKING_TYPE_COLS} FROM booking_types WHERE user_id = $1${opts.activeOnly ? " AND active = TRUE" : ""} ORDER BY created_at ASC`,
    [dataId]
  );
}

export async function cancelBooking(dataId: string, id: string, reason?: string): Promise<BookingRow | null> {
  const existing = await getBooking(dataId, id);
  if (!existing) return null;
  if (existing.status === "cancelled") return existing;
  await query(`UPDATE bookings SET status = 'cancelled', updated_at = NOW() WHERE user_id = $1 AND id = $2`, [dataId, id]);
  const updated = { ...existing, status: "cancelled" as const };
  const cal = await queryOne<{ timezone: string }>(`SELECT timezone FROM calendars WHERE id = $1`, [existing.calendar_id]);
  const when = fmtWhen(existing.starts_at, cal?.timezone ?? "UTC");
  try {
    if (existing.email) {
      await enqueueNotification(dataId, {
        channel: "email",
        recipient: existing.email,
        subject: `Cancelled: your appointment on ${when}`,
        body: `Hi ${existing.name},\n\nYour appointment on ${when} has been cancelled.${reason ? `\n\nReason: ${reason}` : ""}\n`,
        data: { bookingId: id, kind: "booking.cancelled" },
      });
    }
    await enqueueNotification(dataId, {
      channel: "in_app",
      recipient: dataId,
      subject: `Booking cancelled: ${existing.name}`,
      body: `The appointment with ${existing.name} on ${when} was cancelled.`,
      data: { bookingId: id, kind: "booking.cancelled", href: "/calendar" },
    });
  } catch (err) {
    console.error("[booking] notification enqueue failed:", err);
  }
  await emitEvent(dataId, {
    type: "booking.cancelled",
    entity: "booking",
    entityId: id,
    data: { name: existing.name, startsAt: existing.starts_at, reason: reason ?? null },
  });
  return updated;
}

/** Cancel via the customer's plain token (public route). */
export async function cancelBookingByToken(token: string): Promise<BookingRow | null> {
  const row = await queryOne<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM bookings WHERE cancel_token_hash = $1`,
    [hashCancelToken(token)]
  );
  if (!row) return null;
  return cancelBooking(row.user_id, row.id, "Cancelled by the customer");
}

export async function setBookingStatus(dataId: string, id: string, status: "completed" | "no_show"): Promise<BookingRow | null> {
  const existing = await getBooking(dataId, id);
  if (!existing) return null;
  await query(`UPDATE bookings SET status = $3, updated_at = NOW() WHERE user_id = $1 AND id = $2`, [dataId, id, status]);
  return { ...existing, status };
}

/** Local wall-clock label used by tools and pages. */
export function describeInstant(iso: string, timezone: string): string {
  const p = zonedParts(new Date(iso), timezone);
  const hh = String(p.hour).padStart(2, "0");
  const mm = String(p.minute).padStart(2, "0");
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")} ${hh}:${mm} (${timezone})`;
}
