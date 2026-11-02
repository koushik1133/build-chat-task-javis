/**
 * Mail provider contract. Every provider (Gmail, Outlook, IMAP, simulated)
 * speaks this interface so sync, send and the settings UI never branch on
 * provider specifics. Pure types only — safe to `import type` from the client.
 */

export const MAIL_PROVIDERS = ["gmail", "outlook", "imap", "simulated"] as const;
export type MailProviderId = (typeof MAIL_PROVIDERS)[number];

export function isMailProviderId(v: unknown): v is MailProviderId {
  return typeof v === "string" && (MAIL_PROVIDERS as readonly string[]).includes(v);
}

/** Decrypted credential blob stored in mail_accounts.auth. */
export interface MailAuth {
  access_token?: string;
  refresh_token?: string;
  /** Epoch ms when access_token expires. */
  expires_at?: number;
  /** IMAP only. */
  host?: string;
  port?: number;
  username?: string;
  password?: string;
}

/** A provider-neutral message as returned by `listNew`. */
export interface NormalizedMessage {
  providerMessageId: string;
  threadId: string | null;
  direction: "in" | "out";
  from: string;
  /** Display name from the From header, when the provider gives one. */
  fromName?: string | null;
  to: string[];
  subject: string;
  snippet: string;
  bodyText: string;
  bodyHtml: string | null;
  receivedAt: string; // ISO
  isRead: boolean;
  labels: string[];
}

export interface OutboundMail {
  to: string[];
  subject: string;
  text: string;
  html?: string | null;
  /** Provider thread to reply within, when known. */
  threadId?: string | null;
  /** RFC 2822 Message-ID being replied to, when known. */
  inReplyTo?: string | null;
}

export interface ListNewResult {
  messages: NormalizedMessage[];
  cursor: string | null;
}

export interface ExchangeResult {
  auth: MailAuth;
  email: string;
  displayName: string | null;
  cursor: string | null;
}

export interface MailProvider {
  id: MailProviderId;
  label: string;
  /** True when the env vars needed to talk to this provider exist. */
  configured(): boolean;
  /** Human-readable reason when `configured()` is false. */
  unavailableReason(): string | null;
  /** Full URL the browser should be sent to. `state` is the CSRF token. */
  oauthStartUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<ExchangeResult>;
  refresh(auth: MailAuth): Promise<MailAuth>;
  /** Messages that arrived since `cursor` (null = initial backfill). */
  listNew(auth: MailAuth, cursor: string | null, accountId: string): Promise<ListNewResult>;
  send(auth: MailAuth, msg: OutboundMail, accountId: string): Promise<{ providerMessageId: string; threadId: string | null }>;
}

export interface MailAccountRow {
  id: string;
  user_id: string;
  provider: MailProviderId;
  email: string;
  display_name: string | null;
  auth: string | null;
  sync_cursor: string | null;
  status: "connected" | "error" | "disabled";
  last_sync_at: string | null;
  last_error: string | null;
  created_at: string;
}

/** Account as shown to the browser — never includes `auth`. */
export interface MailAccountView {
  id: string;
  provider: MailProviderId;
  email: string;
  display_name: string | null;
  status: "connected" | "error" | "disabled";
  last_sync_at: string | null;
  last_error: string | null;
  created_at: string;
  message_count: number;
}

export interface MailProviderInfo {
  id: MailProviderId;
  label: string;
  configured: boolean;
  reason: string | null;
}
