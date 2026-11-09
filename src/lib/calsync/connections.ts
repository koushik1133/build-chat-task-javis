import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { decryptSecret, encryptSecret, isEncryptionConfigured } from "@/lib/secure-store";
import { googleProvider } from "./providers/google";
import { outlookProvider } from "./providers/outlook";
import { simulatedCalendarProvider } from "./providers/simulated";
import {
  isCalendarProviderId,
  parseSyncSettings,
  type CalendarAuth,
  type CalendarConnectionView,
  type CalendarProvider,
  type CalendarProviderId,
  type CalendarProviderInfo,
  type CalendarSyncSettings,
  type ConnectionStatus,
} from "./types";

const PROVIDERS: Record<CalendarProviderId, CalendarProvider> = { google: googleProvider, outlook: outlookProvider, simulated: simulatedCalendarProvider };

export function getCalendarProvider(id: string): CalendarProvider | null {
  return isCalendarProviderId(id) ? PROVIDERS[id] : null;
}

export function describeCalendarProviders(): CalendarProviderInfo[] {
  return (Object.keys(PROVIDERS) as CalendarProviderId[]).map((id) => {
    const p = PROVIDERS[id];
    const encOk = id === "simulated" || isEncryptionConfigured();
    return { id, label: p.label, configured: p.configured() && encOk, reason: !p.configured() ? p.unavailableReason() : encOk ? null : "Set CREDENTIAL_ENCRYPTION_KEY so calendar tokens can be stored encrypted." };
  });
}

export interface ConnectionRow {
  id: string;
  user_id: string;
  provider: CalendarProviderId;
  account_email: string;
  auth: string | null;
  external_calendar_id: string | null;
  sync_cursor: string | null;
  status: ConnectionStatus;
  last_sync_at: string | null;
  last_error: string | null;
  settings: string | null;
  created_at: string;
}

const COLS = `id, user_id, provider, account_email, auth, external_calendar_id, sync_cursor, status, last_sync_at, last_error, settings, created_at`;

function toView(r: ConnectionRow, busy: number): CalendarConnectionView {
  return {
    id: r.id, provider: r.provider, account_email: r.account_email, external_calendar_id: r.external_calendar_id, status: r.status,
    last_sync_at: r.last_sync_at, last_error: r.last_error, settings: parseSyncSettings(r.settings), created_at: r.created_at, busy_count: busy,
  };
}

export async function listConnections(dataId: string): Promise<CalendarConnectionView[]> {
  const rows = await query<ConnectionRow & { busy_count: string | number }>(
    `SELECT c.id, c.user_id, c.provider, c.account_email, NULL AS auth, c.external_calendar_id, c.sync_cursor, c.status, c.last_sync_at, c.last_error, c.settings, c.created_at,
            (SELECT COUNT(*) FROM external_busy b WHERE b.connection_id = c.id) AS busy_count
       FROM calendar_connections c WHERE c.user_id = $1 ORDER BY c.created_at ASC`,
    [dataId]
  );
  return rows.map((r) => toView(r, Number(r.busy_count) || 0));
}

export async function getConnection(dataId: string, id: string): Promise<ConnectionRow | null> {
  return queryOne<ConnectionRow>(`SELECT ${COLS} FROM calendar_connections WHERE id = $1 AND user_id = $2`, [id, dataId]);
}

/** Internal (cron / event processor) lookup: callers trust the id source. */
export async function getConnectionById(id: string): Promise<ConnectionRow | null> {
  return queryOne<ConnectionRow>(`SELECT ${COLS} FROM calendar_connections WHERE id = $1`, [id]);
}

export function serializeAuth(auth: CalendarAuth, provider: CalendarProviderId): string | null {
  if (provider === "simulated") return null;
  if (!isEncryptionConfigured()) throw new Error("CREDENTIAL_ENCRYPTION_KEY is not set. Cannot store calendar credentials.");
  return encryptSecret(JSON.stringify(auth ?? {}));
}

export function readAuth(row: Pick<ConnectionRow, "auth" | "provider" | "id">): CalendarAuth {
  if (row.provider === "simulated") return { connection_id: row.id };
  if (!row.auth) return {};
  const plain = decryptSecret(row.auth);
  if (!plain) throw new Error("Stored calendar credentials could not be decrypted. Reconnect the account.");
  try {
    return JSON.parse(plain) as CalendarAuth;
  } catch {
    return {};
  }
}

export async function ensureFreshAuth(row: ConnectionRow): Promise<CalendarAuth> {
  const provider = getCalendarProvider(row.provider);
  if (!provider) throw new Error(`Unknown calendar provider ${row.provider}`);
  const auth = readAuth(row);
  if (row.provider === "simulated") return auth;
  if (auth.access_token && (auth.expires_at ?? 0) > Date.now() + 60_000) return auth;
  const next = await provider.refresh(auth);
  await query(`UPDATE calendar_connections SET auth = $1 WHERE id = $2`, [serializeAuth(next, row.provider), row.id]);
  return next;
}

/** Make sure the event cursor exists so events emitted after connecting are never skipped. */
export async function ensureCalsyncCursor(): Promise<void> {
  await query(`INSERT INTO calsync_cursors (name, last_event_at, last_event_id, updated_at) VALUES ('events', NOW(), '', NOW()) ON CONFLICT (name) DO NOTHING`);
}

export async function upsertConnection(
  dataId: string,
  input: { provider: CalendarProviderId; email: string; auth: CalendarAuth; calendarId: string | null }
): Promise<string> {
  const authEnc = serializeAuth(input.auth, input.provider);
  await ensureCalsyncCursor();
  const email = input.email.toLowerCase();
  const existing = await queryOne<{ id: string }>(`SELECT id FROM calendar_connections WHERE user_id = $1 AND provider = $2 AND account_email = $3`, [dataId, input.provider, email]);
  if (existing) {
    await query(`UPDATE calendar_connections SET auth = $1, status = 'connected', last_error = NULL WHERE id = $2`, [authEnc, existing.id]);
    return existing.id;
  }
  const id = randomUUID();
  const settings: CalendarSyncSettings = { push_bookings: true, pull_busy: true, calendar_id: input.calendarId };
  await query(
    `INSERT INTO calendar_connections (id, user_id, provider, account_email, auth, external_calendar_id, status, settings, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'connected', $7, NOW())`,
    [id, dataId, input.provider, email, authEnc, input.calendarId, JSON.stringify(settings)]
  );
  return id;
}

export async function updateConnection(
  dataId: string,
  id: string,
  patch: { settings?: Partial<CalendarSyncSettings>; status?: "connected" | "disabled" }
): Promise<ConnectionRow | null> {
  const row = await getConnection(dataId, id);
  if (!row) return null;
  const settings = { ...parseSyncSettings(row.settings), ...(patch.settings ?? {}) };
  const status = patch.status ?? (row.status === "disabled" ? "disabled" : "connected");
  const calendar = settings.calendar_id ?? row.external_calendar_id;
  await query(
    `UPDATE calendar_connections SET settings = $1, status = $2, external_calendar_id = $3, last_error = CASE WHEN $2 = 'connected' THEN NULL ELSE last_error END WHERE id = $4 AND user_id = $5`,
    [JSON.stringify(settings), status, calendar, id, dataId]
  );
  // Switching calendars, turning pull off or disabling drops stale busy time immediately.
  if (!settings.pull_busy || status === "disabled" || (patch.settings?.calendar_id && patch.settings.calendar_id !== row.external_calendar_id)) {
    await query(`DELETE FROM external_busy WHERE connection_id = $1 AND user_id = $2`, [id, dataId]);
  }
  return getConnection(dataId, id);
}

export async function deleteConnection(dataId: string, id: string): Promise<boolean> {
  const row = await getConnection(dataId, id);
  if (!row) return false;
  await query(`DELETE FROM external_busy WHERE connection_id = $1`, [id]);
  await query(`DELETE FROM calendar_event_links WHERE connection_id = $1`, [id]);
  if (row.provider === "simulated") await query(`DELETE FROM calsync_sim_events WHERE connection_id = $1`, [id]);
  await query(`DELETE FROM calendar_connections WHERE id = $1 AND user_id = $2`, [id, dataId]);
  return true;
}
