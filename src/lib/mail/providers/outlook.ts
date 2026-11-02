import type { ExchangeResult, ListNewResult, MailAuth, MailProvider, NormalizedMessage, OutboundMail } from "../types";
import { parseGraphMessage, type GraphMessage } from "../parse";

/**
 * Outlook / Microsoft 365 via Microsoft Graph. App credentials come from
 * MS_CLIENT_ID / MS_CLIENT_SECRET (optionally MS_TENANT, default "common").
 * Incremental sync uses the inbox delta query; the cursor is the deltaLink.
 */

const TENANT = () => process.env.MS_TENANT?.trim() || "common";
const AUTH_URL = () => `https://login.microsoftonline.com/${TENANT()}/oauth2/v2.0/authorize`;
const TOKEN_URL = () => `https://login.microsoftonline.com/${TENANT()}/oauth2/v2.0/token`;
const GRAPH = "https://graph.microsoft.com/v1.0";
const SCOPES = ["offline_access", "User.Read", "Mail.Read", "Mail.Send"];
const SELECT = "id,conversationId,subject,bodyPreview,receivedDateTime,sentDateTime,isRead,isDraft,from,sender,toRecipients,ccRecipients,body,categories";
const PAGE = 25;
const MAX_PER_SYNC = 50;
const TIMEOUT = 15_000;

function clientId() {
  return process.env.MS_CLIENT_ID?.trim() ?? "";
}
function clientSecret() {
  return process.env.MS_CLIENT_SECRET?.trim() ?? "";
}

async function graph<T>(auth: MailAuth, url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url.startsWith("http") ? url : `${GRAPH}${url}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${auth.access_token ?? ""}`,
      "Content-Type": "application/json",
      Prefer: 'outlook.body-content-type="text"',
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (res.status === 202 || res.status === 204) return {} as T;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Microsoft Graph returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  return (await res.json()) as T;
}

async function token(params: Record<string, string>): Promise<MailAuth> {
  const res = await fetch(TOKEN_URL(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), scope: SCOPES.join(" "), ...params }).toString(),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!res.ok || !data.access_token) throw new Error(data.error_description ?? data.error ?? `Microsoft token endpoint returned ${res.status}`);
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + Math.max(60, data.expires_in ?? 3600) * 1000 - 30_000,
  };
}

async function me(auth: MailAuth): Promise<{ email: string; displayName: string | null }> {
  const u = await graph<{ mail?: string; userPrincipalName?: string; displayName?: string }>(auth, "/me?$select=mail,userPrincipalName,displayName");
  return { email: (u.mail ?? u.userPrincipalName ?? "").toLowerCase(), displayName: u.displayName ?? null };
}

export const outlookProvider: MailProvider = {
  id: "outlook",
  label: "Outlook / Microsoft 365",
  configured: () => Boolean(clientId() && clientSecret()),
  unavailableReason: () => (clientId() && clientSecret() ? null : "Set MS_CLIENT_ID and MS_CLIENT_SECRET to connect Outlook."),

  oauthStartUrl(state, redirectUri) {
    const q = new URLSearchParams({
      client_id: clientId(),
      response_type: "code",
      redirect_uri: redirectUri,
      response_mode: "query",
      scope: SCOPES.join(" "),
      state,
    });
    return `${AUTH_URL()}?${q.toString()}`;
  },

  async exchangeCode(code, redirectUri): Promise<ExchangeResult> {
    const auth = await token({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
    const u = await me(auth);
    if (!u.email) throw new Error("Microsoft account has no mailbox address.");
    return { auth, email: u.email, displayName: u.displayName, cursor: null };
  },

  async refresh(auth) {
    if (!auth.refresh_token) throw new Error("Outlook account has no refresh token — reconnect it.");
    const next = await token({ grant_type: "refresh_token", refresh_token: auth.refresh_token });
    return { ...auth, ...next, refresh_token: next.refresh_token ?? auth.refresh_token };
  },

  async listNew(auth, cursor): Promise<ListNewResult> {
    const u = await me(auth);
    const messages: NormalizedMessage[] = [];
    let url = cursor ?? `/me/mailFolders/inbox/messages/delta?$select=${encodeURIComponent(SELECT)}&$top=${PAGE}`;
    let deltaLink: string | null = cursor;

    for (let page = 0; page < 10; page++) {
      const data: { value?: GraphMessage[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string } = await graph(auth, url);
      for (const m of data.value ?? []) {
        if (m["@removed"] || m.isDraft) continue;
        messages.push(parseGraphMessage(m, u.email));
      }
      if (data["@odata.deltaLink"]) {
        deltaLink = data["@odata.deltaLink"];
        break;
      }
      if (!data["@odata.nextLink"] || messages.length >= MAX_PER_SYNC) {
        deltaLink = data["@odata.deltaLink"] ?? data["@odata.nextLink"] ?? deltaLink;
        break;
      }
      url = data["@odata.nextLink"];
    }
    return { messages, cursor: deltaLink };
  },

  async send(auth, msg: OutboundMail) {
    await graph(auth, "/me/sendMail", {
      method: "POST",
      body: JSON.stringify({
        message: {
          subject: msg.subject,
          body: { contentType: "Text", content: msg.text },
          toRecipients: msg.to.map((address) => ({ emailAddress: { address } })),
        },
        saveToSentItems: true,
      }),
    });
    // sendMail returns 202 with no body; the sent copy is picked up by the next delta sync.
    return { providerMessageId: `outlook-sent-${Date.now()}`, threadId: msg.threadId ?? null };
  },
};
