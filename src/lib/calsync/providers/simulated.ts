import { randomUUID } from "crypto";
import { query } from "@/lib/dsql";
import type { BusyBlock, CalendarProvider, ExchangeResult } from "../types";
import { hashSummary } from "./util";

/**
 * Simulated external calendar for development and tests: events live in
 * `calsync_sim_events`. Pushed bookings are stored with a `simpush_` id prefix
 * so a pull never reads them back as busy time; any other row is "external".
 * The sync layer injects `auth.connection_id`.
 */

export const SIM_CALENDAR_ID = "sim-primary";
const PUSH_PREFIX = "simpush_";

function conn(auth: { connection_id?: string }): string {
  if (!auth.connection_id) throw new Error("Simulated calendar needs a connection id.");
  return auth.connection_id;
}

/** Test/dev helper: add an external event to the simulated calendar. */
export async function addSimulatedExternalEvent(connectionId: string, input: { title?: string; startsAt: string; endsAt: string }): Promise<string> {
  const id = `ext_${randomUUID()}`;
  await query(`INSERT INTO calsync_sim_events (id, connection_id, calendar_id, title, starts_at, ends_at) VALUES ($1, $2, $3, $4, $5, $6)`, [
    id, connectionId, SIM_CALENDAR_ID, input.title ?? "Busy", input.startsAt, input.endsAt,
  ]);
  return id;
}

export async function listSimulatedEvents(connectionId: string): Promise<Array<{ id: string; title: string | null; starts_at: string; ends_at: string }>> {
  return query(`SELECT id, title, starts_at, ends_at FROM calsync_sim_events WHERE connection_id = $1 ORDER BY starts_at ASC`, [connectionId]);
}

export const simulatedCalendarProvider: CalendarProvider = {
  id: "simulated",
  label: "Simulated calendar",
  configured: () => true,
  unavailableReason: () => null,
  oauthStartUrl: () => "",
  async exchangeCode(): Promise<ExchangeResult> {
    return { auth: {}, email: "calendar@simulated.local", calendarId: SIM_CALENDAR_ID };
  },
  async refresh(auth) {
    return auth;
  },
  async listCalendars() {
    return [{ id: SIM_CALENDAR_ID, name: "Simulated calendar", primary: true }];
  },
  async listBusy(auth, calendarId, from, to, cursor) {
    const rows = await query<{ id: string; title: string | null; starts_at: string; ends_at: string }>(
      `SELECT id, title, starts_at, ends_at FROM calsync_sim_events
        WHERE connection_id = $1 AND calendar_id = $2 AND id NOT LIKE '${PUSH_PREFIX}%' AND starts_at < $4 AND ends_at > $3`,
      [conn(auth), calendarId, from.toISOString(), to.toISOString()]
    );
    const blocks: BusyBlock[] = rows.map((r) => ({
      externalEventId: r.id,
      startsAt: new Date(r.starts_at).toISOString(),
      endsAt: new Date(r.ends_at).toISOString(),
      summaryHash: hashSummary(r.title),
    }));
    return { blocks, cursor };
  },
  async upsertEvent(auth, calendarId, ev, externalId) {
    const c = conn(auth);
    if (externalId) {
      const rows = await query<{ id: string }>(
        `UPDATE calsync_sim_events SET title = $1, starts_at = $2, ends_at = $3, updated_at = NOW() WHERE id = $4 AND connection_id = $5 RETURNING id`,
        [ev.summary, ev.startsAt, ev.endsAt, externalId, c]
      );
      if (rows.length) return { externalId, etag: String(Date.now()) };
    }
    const id = `${PUSH_PREFIX}${randomUUID()}`;
    await query(`INSERT INTO calsync_sim_events (id, connection_id, calendar_id, title, starts_at, ends_at) VALUES ($1, $2, $3, $4, $5, $6)`, [id, c, calendarId, ev.summary, ev.startsAt, ev.endsAt]);
    return { externalId: id, etag: String(Date.now()) };
  },
  async deleteEvent(auth, _calendarId, externalId) {
    await query(`DELETE FROM calsync_sim_events WHERE id = $1 AND connection_id = $2`, [externalId, conn(auth)]);
  },
};
