/** Calendar-sync contracts. Pure types and constants: safe to import from client code. */

export const CALENDAR_PROVIDERS = ["google", "outlook", "simulated"] as const;
export type CalendarProviderId = (typeof CALENDAR_PROVIDERS)[number];

export function isCalendarProviderId(v: unknown): v is CalendarProviderId {
  return typeof v === "string" && (CALENDAR_PROVIDERS as readonly string[]).includes(v);
}

export interface CalendarAuth {
  access_token?: string;
  refresh_token?: string;
  /** Epoch ms when access_token expires. */
  expires_at?: number;
  /** Simulated provider only: injected by the sync layer, never stored. */
  connection_id?: string;
}

export interface CalendarInfo {
  id: string;
  name: string;
  primary: boolean;
}

/** A busy window pulled from an external calendar. Titles and attendees are never carried. */
export interface BusyBlock {
  externalEventId: string;
  startsAt: string;
  endsAt: string;
  summaryHash: string | null;
}

/** The (privacy-minimal) event pushed for a booking. */
export interface PushEvent {
  bookingId: string;
  summary: string;
  description: string;
  startsAt: string;
  endsAt: string;
}

export interface ExchangeResult {
  auth: CalendarAuth;
  email: string;
  calendarId: string | null;
}

export interface CalendarProvider {
  id: CalendarProviderId;
  label: string;
  configured(): boolean;
  unavailableReason(): string | null;
  oauthStartUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<ExchangeResult>;
  refresh(auth: CalendarAuth): Promise<CalendarAuth>;
  listCalendars(auth: CalendarAuth): Promise<CalendarInfo[]>;
  listBusy(auth: CalendarAuth, calendarId: string, from: Date, to: Date, cursor: string | null): Promise<{ blocks: BusyBlock[]; cursor: string | null }>;
  upsertEvent(auth: CalendarAuth, calendarId: string, event: PushEvent, externalId: string | null): Promise<{ externalId: string; etag: string | null }>;
  deleteEvent(auth: CalendarAuth, calendarId: string, externalId: string): Promise<void>;
}

export interface CalendarSyncSettings {
  push_bookings: boolean;
  pull_busy: boolean;
  calendar_id: string | null;
}

export const DEFAULT_SYNC_SETTINGS: CalendarSyncSettings = { push_bookings: true, pull_busy: true, calendar_id: null };

export type ConnectionStatus = "connected" | "error" | "disabled";

export interface CalendarConnectionView {
  id: string;
  provider: CalendarProviderId;
  account_email: string;
  external_calendar_id: string | null;
  status: ConnectionStatus;
  last_sync_at: string | null;
  last_error: string | null;
  settings: CalendarSyncSettings;
  created_at: string;
  busy_count: number;
}

export interface CalendarProviderInfo {
  id: CalendarProviderId;
  label: string;
  configured: boolean;
  reason: string | null;
}

export function parseSyncSettings(raw: string | null | undefined): CalendarSyncSettings {
  let o: Record<string, unknown> = {};
  try {
    const v = raw ? (JSON.parse(raw) as unknown) : {};
    if (v && typeof v === "object" && !Array.isArray(v)) o = v as Record<string, unknown>;
  } catch {
    /* defaults */
  }
  return {
    push_bookings: typeof o.push_bookings === "boolean" ? o.push_bookings : DEFAULT_SYNC_SETTINGS.push_bookings,
    pull_busy: typeof o.pull_busy === "boolean" ? o.pull_busy : DEFAULT_SYNC_SETTINGS.pull_busy,
    calendar_id: typeof o.calendar_id === "string" && o.calendar_id ? o.calendar_id : null,
  };
}
