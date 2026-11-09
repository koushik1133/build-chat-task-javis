import type { BusyBlock, CalendarAuth, CalendarInfo, CalendarProvider, ExchangeResult, PushEvent } from "../types";
import { hashSummary, httpJson, tokenRequest } from "./util";

/** Outlook / Microsoft 365 via Graph calendarView. Credentials: MS_CLIENT_ID / MS_CLIENT_SECRET (shared with Outlook inbox sync). */

const TENANT = () => process.env.MS_TENANT?.trim() || "common";
const AUTH_URL = () => `https://login.microsoftonline.com/${TENANT()}/oauth2/v2.0/authorize`;
const TOKEN_URL = () => `https://login.microsoftonline.com/${TENANT()}/oauth2/v2.0/token`;
const GRAPH = "https://graph.microsoft.com/v1.0";
const SCOPES = ["offline_access", "User.Read", "Calendars.ReadWrite"];
const TAG = "KernelHub";

const clientId = () => process.env.MS_CLIENT_ID?.trim() ?? "";
const clientSecret = () => process.env.MS_CLIENT_SECRET?.trim() ?? "";
const enc = encodeURIComponent;

interface GraphEvent {
  id: string;
  subject?: string;
  isCancelled?: boolean;
  showAs?: string;
  categories?: string[];
  start?: { dateTime: string };
  end?: { dateTime: string };
  "@odata.etag"?: string;
}

/** Graph returns UTC wall-clock without a zone when we ask for Prefer: outlook.timezone="UTC". */
function asUtcIso(dt: string): string {
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(dt) ? dt : `${dt}Z`).toISOString();
}

const PREFER = { Prefer: 'outlook.timezone="UTC"' };

export const outlookProvider: CalendarProvider = {
  id: "outlook",
  label: "Outlook Calendar",
  configured: () => Boolean(clientId() && clientSecret()),
  unavailableReason: () => (clientId() && clientSecret() ? null : "Set MS_CLIENT_ID and MS_CLIENT_SECRET to connect Outlook Calendar."),

  oauthStartUrl(state, redirectUri) {
    const q = new URLSearchParams({ client_id: clientId(), redirect_uri: redirectUri, response_type: "code", scope: SCOPES.join(" "), response_mode: "query", prompt: "select_account", state });
    return `${AUTH_URL()}?${q.toString()}`;
  },

  async exchangeCode(code, redirectUri): Promise<ExchangeResult> {
    const auth = await tokenRequest("Microsoft", TOKEN_URL(), { client_id: clientId(), client_secret: clientSecret(), grant_type: "authorization_code", code, redirect_uri: redirectUri, scope: SCOPES.join(" ") });
    const me = await httpJson<{ mail?: string; userPrincipalName?: string }>("Graph /me", `${GRAPH}/me?$select=mail,userPrincipalName`, { token: auth.access_token });
    return { auth, email: (me.mail ?? me.userPrincipalName ?? "").toLowerCase(), calendarId: null };
  },

  async refresh(auth): Promise<CalendarAuth> {
    if (!auth.refresh_token) throw new Error("Microsoft account has no refresh token. Reconnect it.");
    const next = await tokenRequest("Microsoft", TOKEN_URL(), { client_id: clientId(), client_secret: clientSecret(), grant_type: "refresh_token", refresh_token: auth.refresh_token, scope: SCOPES.join(" ") });
    return { ...auth, ...next, refresh_token: next.refresh_token ?? auth.refresh_token };
  },

  async listCalendars(auth): Promise<CalendarInfo[]> {
    const r = await httpJson<{ value?: Array<{ id: string; name?: string; isDefaultCalendar?: boolean; canEdit?: boolean }> }>("Graph calendars", `${GRAPH}/me/calendars?$top=50`, { token: auth.access_token });
    return (r.value ?? []).filter((c) => c.canEdit !== false).map((c) => ({ id: c.id, name: c.name ?? c.id, primary: Boolean(c.isDefaultCalendar) }));
  },

  async listBusy(auth, calendarId, from, to, cursor) {
    const blocks: BusyBlock[] = [];
    let url: string | null = `${GRAPH}/me/calendars/${enc(calendarId)}/calendarView?startDateTime=${enc(from.toISOString())}&endDateTime=${enc(to.toISOString())}&$top=100&$select=id,subject,isCancelled,showAs,categories,start,end`;
    let pages = 0;
    while (url && pages++ < 20) {
      const page: { value?: GraphEvent[]; "@odata.nextLink"?: string } = await httpJson("Graph calendarView", url, { token: auth.access_token, headers: PREFER });
      for (const e of page.value ?? []) {
        if (e.isCancelled || e.showAs === "free") continue;
        if ((e.categories ?? []).includes(TAG)) continue; // our own pushed bookings
        if (!e.start || !e.end) continue;
        blocks.push({ externalEventId: e.id, startsAt: asUtcIso(e.start.dateTime), endsAt: asUtcIso(e.end.dateTime), summaryHash: hashSummary(e.subject) });
      }
      url = page["@odata.nextLink"] ?? null;
    }
    return { blocks, cursor };
  },

  async upsertEvent(auth, calendarId, ev: PushEvent, externalId) {
    const body = JSON.stringify({
      subject: ev.summary,
      body: { contentType: "text", content: ev.description },
      start: { dateTime: ev.startsAt.replace(/Z$/, ""), timeZone: "UTC" },
      end: { dateTime: ev.endsAt.replace(/Z$/, ""), timeZone: "UTC" },
      categories: [TAG],
    });
    const r = externalId
      ? await httpJson<GraphEvent>("Graph update event", `${GRAPH}/me/events/${enc(externalId)}`, { method: "PATCH", body, token: auth.access_token })
      : await httpJson<GraphEvent>("Graph create event", `${GRAPH}/me/calendars/${enc(calendarId)}/events`, { method: "POST", body, token: auth.access_token });
    return { externalId: r.id, etag: r["@odata.etag"] ?? null };
  },

  async deleteEvent(auth, _calendarId, externalId) {
    try {
      await httpJson<void>("Graph delete event", `${GRAPH}/me/events/${enc(externalId)}`, { method: "DELETE", token: auth.access_token });
    } catch (err) {
      if ((err as { status?: number }).status !== 404) throw err;
    }
  },
};
