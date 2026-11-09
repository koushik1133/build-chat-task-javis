import { query, queryOne } from "@/lib/dsql";
import type { PlaybookDef } from "./types";

/**
 * A day in the next 7 with confirmed bookings but no published shift.
 * Entity id = the Y-M-D day. Only fires for workspaces that use the rota
 * (at least one active staff profile) so solo operators are left alone.
 */
export const understaffedDay: PlaybookDef = {
  id: "understaffed-day",
  name: "Understaffed day",
  description: "Spots upcoming days that have bookings but nobody rostered, and drafts shifts to cover them.",
  eventTypes: ["booking.created", "shift.published", "leave.decided"],
  cooldownHours: 24,
  defaultTools: ["workforce.schedule_gaps", "workforce.create_shift", "workforce.leave_requests"],
  async detect(userId) {
    const hasStaff = await queryOne<{ id: string }>(`SELECT id FROM staff_profiles WHERE user_id = $1 AND active = TRUE LIMIT 1`, [userId]).catch(() => null);
    if (!hasStaff) return [];
    const rows = await query<{ day: string }>(
      `SELECT DISTINCT (b.starts_at AT TIME ZONE 'UTC')::date::text AS day FROM bookings b
        WHERE b.user_id = $1 AND b.status IN ('confirmed') AND b.starts_at >= NOW() AND b.starts_at < NOW() + INTERVAL '7 days'
          AND NOT EXISTS (
            SELECT 1 FROM shifts s WHERE s.user_id = b.user_id AND s.status IN ('published','confirmed','swapped')
              AND s.starts_at < b.ends_at AND s.ends_at > b.starts_at
          )
        ORDER BY day ASC LIMIT 5`,
      [userId]
    ).catch(() => []);
    return rows.map((r) => r.day);
  },
  async buildPrompt(userId, day) {
    const n = await queryOne<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM bookings WHERE user_id = $1 AND status = 'confirmed' AND (starts_at AT TIME ZONE 'UTC')::date = $2::date`,
      [userId, day]
    ).catch(() => null);
    return [
      `${day} has ${n?.n ?? "some"} confirmed booking(s) but no published shift covering them.`,
      "",
      "1. Call workforce.schedule_gaps for that day to see the bookings and who is available (not on leave, not already scheduled).",
      "2. Propose one or two shifts that cover the booking window with workforce.create_shift (these pause for approval). Prefer staff whose role matches and who have the fewest hours this week.",
      "3. If nobody is available, say so clearly and finish.",
    ].join("\n");
  },
};
