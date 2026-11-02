import type { ExchangeResult, ListNewResult, MailAuth, MailProvider, NormalizedMessage, OutboundMail } from "../types";
import { buildRawEmail, parseGmailMessage, type GmailMessage } from "../parse";

/**
 * Gmail via the REST API (no SDK). OAuth app credentials come from
 * GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. Incremental sync uses history.list
 * keyed by the mailbox historyId; a 404 there (history expired) falls back to
 * a plain messages.list of the inbox.
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/userinfo.email"];
const BACKFILL = 20;
const MAX_PER_SYNC = 50;
const TIMEOUT = 15_000;

function clientId() {
  return process.env.GOOGLE_CLIENT_ID?.trim() ?? "";
}
function clientSecret() {
  return process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
}

async function api<T>(auth: MailAuth, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${auth.access_token ?? ""}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`Gmail ${path.split("?")[0]} returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

async function token(params: Record<string, string>): Promise<MailAuth> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), ...params }).toString(),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!res.ok || !data.access_token) throw new Error(data.error_description ?? data.error ?? `Google token endpoint returned ${res.status}`);
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + Math.max(60, data.expires_in ?? 3600) * 1000 - 30_000,
  };
}

async function profile(auth: MailAuth): Promise<{ emailAddress: string; historyId?: string }> {
  return api<{ emailAddress: string; historyId?: string }>(auth, "/profile");
}

async function fetchMessages(auth: MailAuth, ids: string[], accountEmail: string): Promise<NormalizedMessage[]> {
  const out: NormalizedMessage[] = [];
  for (const id of ids.slice(0, MAX_PER_SYNC)) {
    try {
      const msg = await api<GmailMessage>(auth, `/messages/${encodeURIComponent(id)}?format=full`);
      out.push(parseGmailMessage(msg, accountEmail));
    } catch (err) {
      // A single unreadable message must not stall the whole mailbox.
      console.warn(`[mail/gmail] skip message ${id}:`, err instanceof Error ? err.message : err);
    }
  }
  return out;
}

export const gmailProvider: MailProvider = {
  id: "gmail",
  label: "Gmail",
  configured: () => Boolean(clientId() && clientSecret()),
  unavailableReason: () => (clientId() && clientSecret() ? null : "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to connect Gmail."),

  oauthStartUrl(state, redirectUri) {
    const q = new URLSearchParams({
      client_id: clientId(),
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    });
    return `${AUTH_URL}?${q.toString()}`;
  },

  async exchangeCode(code, redirectUri): Promise<ExchangeResult> {
    const auth = await token({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
    const p = await profile(auth);
    return { auth, email: p.emailAddress.toLowerCase(), displayName: null, cursor: p.historyId ?? null };
  },

  async refresh(auth) {
    if (!auth.refresh_token) throw new Error("Gmail account has no refresh token — reconnect it.");
    const next = await token({ grant_type: "refresh_token", refresh_token: auth.refresh_token });
    return { ...auth, ...next, refresh_token: next.refresh_token ?? auth.refresh_token };
  },

  async listNew(auth, cursor): Promise<ListNewResult> {
    const me = await profile(auth);
    const email = me.emailAddress.toLowerCase();

    if (cursor) {
      try {
        const ids = new Set<string>();
        let pageToken: string | undefined;
        let latest = cursor;
        do {
          const q = new URLSearchParams({ startHistoryId: cursor, historyTypes: "messageAdded", labelId: "INBOX", maxResults: "100" });
          if (pageToken) q.set("pageToken", pageToken);
          const page = await api<{ history?: Array<{ messagesAdded?: Array<{ message: { id: string } }> }>; historyId?: string; nextPageToken?: string }>(
            auth,
            `/history?${q.toString()}`
          );
          for (const h of page.history ?? []) for (const a of h.messagesAdded ?? []) ids.add(a.message.id);
          if (page.historyId) latest = page.historyId;
          pageToken = page.nextPageToken;
        } while (pageToken && ids.size < MAX_PER_SYNC);
        const messages = await fetchMessages(auth, [...ids], email);
        return { messages, cursor: me.historyId ?? latest };
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status !== 404) throw err;
        // History expired — fall through to a backfill from the current inbox.
      }
    }

    const list = await api<{ messages?: Array<{ id: string }> }>(auth, `/messages?labelIds=INBOX&maxResults=${BACKFILL}`);
    const messages = await fetchMessages(auth, (list.messages ?? []).map((m) => m.id), email);
    return { messages, cursor: me.historyId ?? null };
  },

  async send(auth, msg: OutboundMail) {
    const me = await profile(auth);
    const raw = buildRawEmail({ from: me.emailAddress, to: msg.to, subject: msg.subject, text: msg.text, inReplyTo: msg.inReplyTo ?? null });
    const body: { raw: string; threadId?: string } = { raw };
    if (msg.threadId) body.threadId = msg.threadId;
    const sent = await api<{ id: string; threadId?: string }>(auth, "/messages/send", { method: "POST", body: JSON.stringify(body) });
    return { providerMessageId: sent.id, threadId: sent.threadId ?? msg.threadId ?? null };
  },
};
