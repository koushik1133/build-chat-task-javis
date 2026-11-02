import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { query, queryOne } from "@/lib/dsql";
import { SCIM_CONTENT_TYPE, scimError, type ScimType } from "./schema";

/**
 * SCIM bearer tokens. One token authorises provisioning for exactly one
 * workspace: `user_id` is the org data id (organizations.owner_user_id), so a
 * client workspace in agency mode gets its own tokens. Only the SHA-256 of the
 * token is stored; the plaintext is returned once at creation.
 */

export const SCIM_TOKEN_PREFIX = "scim_";

export interface ScimTokenView {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface ScimTokenRow extends ScimTokenView {
  user_id: string;
  token_hash: string;
}

export function hashScimToken(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

export async function createScimToken(dataId: string, name: string): Promise<{ token: string; record: ScimTokenView }> {
  const token = `${SCIM_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const id = randomUUID();
  const created_at = new Date().toISOString();
  const clean = name.trim().slice(0, 60) || "SCIM token";
  await query(
    `INSERT INTO scim_tokens (id, user_id, name, token_hash, created_at) VALUES ($1, $2, $3, $4, $5)`,
    [id, dataId, clean, hashScimToken(token), created_at]
  );
  return { token, record: { id, name: clean, created_at, last_used_at: null, revoked_at: null } };
}

export async function listScimTokens(dataId: string): Promise<ScimTokenView[]> {
  return query<ScimTokenView>(
    `SELECT id, name, created_at, last_used_at, revoked_at FROM scim_tokens WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [dataId]
  );
}

export async function revokeScimToken(dataId: string, id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE scim_tokens SET revoked_at = NOW() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
    [id, dataId]
  );
  return rows.length > 0;
}

/** Extract the bearer token from an Authorization header, or null. */
export function bearerFrom(header: string | null | undefined): string | null {
  const m = /^\s*Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return m ? m[1] : null;
}

export interface ScimContext {
  tokenId: string;
  /** Org data id — the user_id key of every table for this workspace. */
  dataId: string;
  orgId: string;
  orgName: string;
}

/** Resolve a plaintext token to its workspace. Null for unknown, malformed or revoked tokens. */
export async function verifyScimToken(plaintext: string | null | undefined): Promise<ScimContext | null> {
  const tok = plaintext?.trim();
  if (!tok || !tok.startsWith(SCIM_TOKEN_PREFIX) || tok.length < 20) return null;
  const hash = hashScimToken(tok);
  const row = await queryOne<ScimTokenRow>(
    `SELECT id, user_id, name, token_hash, created_at, last_used_at, revoked_at FROM scim_tokens WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hash]
  ).catch(() => null);
  if (!row) return null;
  // Belt and braces: the index lookup already matched, but compare in constant time anyway.
  const a = Buffer.from(row.token_hash, "utf8");
  const b = Buffer.from(hash, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const org = await queryOne<{ id: string; name: string }>(`SELECT id, name FROM organizations WHERE owner_user_id = $1`, [row.user_id]).catch(() => null);
  if (!org) return null;
  void query(`UPDATE scim_tokens SET last_used_at = NOW() WHERE id = $1`, [row.id]).catch(() => undefined);
  return { tokenId: row.id, dataId: row.user_id, orgId: org.id, orgName: org.name };
}

export function scimJson(body: unknown, status = 200, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { "Content-Type": SCIM_CONTENT_TYPE, ...headers } });
}

export function scimErrorResponse(status: number, detail: string, scimType?: ScimType): NextResponse {
  const headers: Record<string, string> = {};
  if (status === 401) headers["WWW-Authenticate"] = 'Bearer realm="scim"';
  return scimJson(scimError(status, detail, scimType), status, headers);
}

/** Authenticate a SCIM request. Returns the context or a ready-to-send 401. */
export async function authenticateScim(req: Request): Promise<{ ok: true; ctx: ScimContext } | { ok: false; res: NextResponse }> {
  const token = bearerFrom(req.headers.get("authorization"));
  if (!token) return { ok: false, res: scimErrorResponse(401, "Missing bearer token.") };
  const ctx = await verifyScimToken(token);
  if (!ctx) return { ok: false, res: scimErrorResponse(401, "Invalid or revoked SCIM token.") };
  return { ok: true, ctx };
}

/** `https://host/api/scim/v2` for the current request. */
export function scimBaseUrl(req: Request): string {
  const u = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto") ?? u.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? u.host;
  return `${proto}://${host}/api/scim/v2`;
}
