import { createHash, randomBytes, randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";
import { SESSION_TTL_MS } from "./config";

/**
 * Web chat sessions. The visitor holds a random bearer token; only its sha256
 * is stored. A session owns one messaging_conversation (channel "webchat").
 */

export type ChatSessionStatus = "open" | "handed_off" | "closed";

export interface ChatSessionRow {
  id: string;
  user_id: string;
  site_id: string;
  visitor_id: string | null;
  conversation_id: string | null;
  contact_id: string | null;
  lead_id: string | null;
  status: ChatSessionStatus;
  page_url: string | null;
  user_agent: string | null;
  expires_at: string;
  started_at: string;
  last_seen_at: string;
  closed_at: string | null;
}

export const SESSION_COLS = "id, user_id, site_id, visitor_id, conversation_id, contact_id, lead_id, status, page_url, user_agent, expires_at, started_at, last_seen_at, closed_at";

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function hashIp(ip: string | null | undefined): string | null {
  if (!ip || ip === "unknown") return null;
  return createHash("sha256").update(`webchat-ip:${ip}`, "utf8").digest("hex").slice(0, 32);
}

export function newSessionToken(): string {
  return randomBytes(24).toString("base64url");
}

export function isExpired(expiresAt: string | Date, now = new Date()): boolean {
  const t = typeof expiresAt === "string" ? Date.parse(expiresAt) : expiresAt.getTime();
  return !Number.isFinite(t) || t <= now.getTime();
}

export function tokenLooksValid(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{20,64}$/.test(token);
}

export interface StartSessionInput {
  visitorId?: string | null;
  pageUrl?: string | null;
  userAgent?: string | null;
  ip?: string | null;
}

export interface StartedSession {
  session: ChatSessionRow;
  /** Plain token — returned once to the visitor. */
  token: string;
  expiresAt: string;
}

/** Create a session for a site. Returns null when the site does not exist. */
export async function startSession(siteId: string, input: StartSessionInput = {}): Promise<StartedSession | null> {
  const site = await queryOne<{ user_id: string }>(`SELECT user_id FROM sites WHERE id = $1 AND deleted_at IS NULL`, [siteId]);
  if (!site) return null;

  const token = newSessionToken();
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const row = await queryOne<ChatSessionRow>(
    `INSERT INTO chat_sessions (id, user_id, site_id, visitor_id, session_token_hash, status, page_url, user_agent, ip_hash, expires_at, started_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, 'open', $6, $7, $8, $9, NOW(), NOW()) RETURNING ${SESSION_COLS}`,
    [id, site.user_id, siteId, input.visitorId?.slice(0, 80) ?? null, hashSessionToken(token), input.pageUrl?.slice(0, 1000) ?? null, input.userAgent?.slice(0, 300) ?? null, hashIp(input.ip), expiresAt]
  );
  if (!row) throw new Error("chat_sessions insert returned no row");
  void emitEvent(site.user_id, { type: "webchat.session_started", entity: "chat_session", entityId: id, data: { siteId, pageUrl: row.page_url } });
  return { session: row, token, expiresAt };
}

/** Resolve a bearer token to a live (unexpired, unclosed-or-closed) session for the given site. */
export async function resolveSession(siteId: string, token: unknown): Promise<ChatSessionRow | null> {
  if (!tokenLooksValid(token)) return null;
  const row = await queryOne<ChatSessionRow>(
    `SELECT ${SESSION_COLS} FROM chat_sessions WHERE session_token_hash = $1 AND site_id = $2`,
    [hashSessionToken(token), siteId]
  );
  if (!row || isExpired(row.expires_at)) return null;
  return row;
}

export async function touchSession(id: string): Promise<void> {
  await query(`UPDATE chat_sessions SET last_seen_at = NOW() WHERE id = $1`, [id]).catch(() => undefined);
}

export async function setSessionStatus(id: string, status: ChatSessionStatus): Promise<void> {
  await query(
    `UPDATE chat_sessions SET status = $2, closed_at = CASE WHEN $2 = 'closed' THEN NOW() ELSE closed_at END, last_seen_at = NOW() WHERE id = $1`,
    [id, status]
  );
}

export async function closeSession(id: string): Promise<void> {
  await setSessionStatus(id, "closed");
}

export async function getSession(dataId: string, id: string): Promise<ChatSessionRow | null> {
  return queryOne<ChatSessionRow>(`SELECT ${SESSION_COLS} FROM chat_sessions WHERE id = $1 AND user_id = $2`, [id, dataId]);
}

export async function getSessionByConversation(dataId: string, conversationId: string): Promise<ChatSessionRow | null> {
  return queryOne<ChatSessionRow>(`SELECT ${SESSION_COLS} FROM chat_sessions WHERE conversation_id = $1 AND user_id = $2`, [conversationId, dataId]);
}

export interface SessionListOptions {
  status?: ChatSessionStatus | "active" | "all";
  limit?: number;
}

export async function listSessions(dataId: string, opts: SessionListOptions = {}): Promise<ChatSessionRow[]> {
  const status = opts.status ?? "active";
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const where = status === "all" ? "" : status === "active" ? " AND status IN ('open','handed_off')" : " AND status = $3";
  const params: unknown[] = [dataId, limit];
  if (status !== "all" && status !== "active") params.push(status);
  return query<ChatSessionRow>(`SELECT ${SESSION_COLS} FROM chat_sessions WHERE user_id = $1${where} ORDER BY last_seen_at DESC LIMIT $2`, params);
}
