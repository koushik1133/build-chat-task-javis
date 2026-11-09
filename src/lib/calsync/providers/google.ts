import type { BusyBlock, CalendarAuth, CalendarInfo, CalendarProvider, ExchangeResult, PushEvent } from "../types";
import { hashSummary, httpJson, tokenRequest } from "./util";

/** Google Calendar REST v3. Credentials: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (shared with Gmail inbox sync). */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3";
const SCOPES = ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.calendarlist.readonly", "https://www.googleapis.com/auth/userinfo.email"];

const clientId = () => process.env.GOOGLE_CLIENT_ID?.trim() ?? "";
const clientSecret = () => process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
const enc = encodeURIComponent;

interface GEvent {
  id: string;
  etag?: string;
  summary?: string;
  status?: string;
  transparency?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
}

export const googleProvider: CalendarProvider = {
  id: "google",
  label: "Google Calendar",
  configured: () => Boolean(clientId() && clientSecret()),
  unavailableReason: () => (clientId() && clientSecret() ? null : "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to connect Google Calendar."),

  oauthStartUrl(state, redirectUri) {
    const q = new URLSearchParams({ client_id: clientId(), redirect_uri: redirectUri, response_type: "code", scope: SCOPES.join(" "), access_type: "offline", prompt: "consent", state });
    return `${AUTH_URL}?${q.toString()}`;
  },

  async exchangeCode(code, redirectUri): Promise<ExchangeResult> {
    const auth = await tokenRequest("Google", TOKEN_URL, { client_id: clientId(), client_secret: clientSecret(), grant_type: "authorization_code", code, redirect_uri: redirectUri });
    const me = await httpJson<{ email?: string }>("Google userinfo", "https://www.googleapis.com/oauth2/v2/userinfo", { token: auth.access_token });
    return { auth, email: (me.email ?? "").toLowerCase(), calendarId: "primary" };
  },

  async refresh(auth): Promise<CalendarAuth> {
    if (!auth.refresh_token) throw new Error("Google account has no refresh token. Reconnect it.");
    const next = await tokenRequest("Google", TOKEN_URL, { client_id: clientId(), client_secret: clientSecret(), grant_type: "refresh_token", refresh_token: auth.refresh_token });
    return { ...auth, ...next, refresh_token: next.refresh_token ?? auth.refresh_token };
  },

  async listCalendars(auth): Promise<CalendarInfo[]> {
    const r = await httpJson<{ items?: Array<{ id: string; summary?: string; primary?: boolean; accessRole?: string }> }>("Google calendarList", `${API}/users/me/calendarList?minAccessRole=writer`, { token: auth.access_token });
    return (r.items ?? []).map((c) => ({ id: c.id, name: c.summary ?? c.id, primary: Boolean(c.primary) }));
  },

  async listBusy(auth, calendarId, from, to, cursor) {
    const blocks: BusyBlock[] = [];
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "250" });
      if (pageToken) q.set("pageToken", pageToken);
      const page = await httpJson<{ items?: GEvent[]; nextPageToken?: string }>("Google events", `${API}/calendars/${enc(calendarId)}/events?${q.toString()}`, { token: auth.access_token });
      for (const e of page.items ?? []) {
        if (e.status === "cancelled" || e.transparency === "transparent") continue;
        if (e.extendedProperties?.private?.kh_booking) continue; // our own pushed bookings
        const s = e.start?.dateTime ?? (e.start?.date ? `${e.start.date}T00:00:00Z` : null);
        const en = e.end?.dateTime ?? (e.end?.date ? `${e.end.date}T00:00:00Z` : null);
        if (!s || !en) continue;
        blocks.push({ externalEventId: e.id, startsAt: new Date(s).toISOString(), endsAt: new Date(en).toISOString(), summaryHash: hashSummary(e.summary) });
      }
      pageToken = page.nextPageToken;
    } while (pageToken && blocks.length < 2000);
    return { blocks, cursor };
  },

  async upsertEvent(auth, calendarId, ev: PushEvent, externalId) {
    const body = JSON.stringify({
      summary: ev.summary,
      description: ev.description,
      start: { dateTime: ev.startsAt },
      end: { dateTime: ev.endsAt },
      extendedProperties: { private: { kh_booking: ev.bookingId } },
    });
    const base = `${API}/calendars/${enc(calendarId)}/events`;
    const r = externalId
      ? await httpJson<GEvent>("Google update event", `${base}/${enc(externalId)}`, { method: "PUT", body, token: auth.access_token })
      : await httpJson<GEvent>("Google create event", base, { method: "POST", body, token: auth.access_token });
    return { externalId: r.id, etag: r.etag ?? null };
  },

  async deleteEvent(auth, calendarId, externalId) {
    try {
      await httpJson<void>("Google delete event", `${API}/calendars/${enc(calendarId)}/events/${enc(externalId)}`, { method: "DELETE", token: auth.access_token });
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status !== 404 && status !== 410) throw err;
    }
  },
};
