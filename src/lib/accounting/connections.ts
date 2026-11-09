import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { decryptSecret, encryptSecret, isEncryptionConfigured } from "@/lib/secure-store";
import { quickbooksProvider } from "./providers/quickbooks";
import { xeroProvider } from "./providers/xero";
import { simulatedProvider } from "./providers/simulated";
import {
  isLiveAccountingProviderId,
  type AccountingAuth, type AccountingConnectionRow, type AccountingConnectionView, type AccountingEntityKind, type AccountingLinkRow,
  type AccountingSettings, type AccountingSyncLogRow, type ConnectionContext, type LiveAccountingProvider, type LiveAccountingProviderId,
} from "./types";

/** Live providers + connection/link/log persistence. Credentials are encrypted with secure-store. */

const PROVIDERS: Record<LiveAccountingProviderId, LiveAccountingProvider> = {
  quickbooks: quickbooksProvider,
  xero: xeroProvider,
  simulated: simulatedProvider,
};

export function getLiveProvider(id: string): LiveAccountingProvider | null {
  return isLiveAccountingProviderId(id) ? PROVIDERS[id] : null;
}

export interface LiveProviderInfo {
  id: LiveAccountingProviderId;
  label: string;
  configured: boolean;
  reason: string | null;
  env: string[];
}

const ENV_HINTS: Record<LiveAccountingProviderId, string[]> = {
  quickbooks: ["QBO_CLIENT_ID", "QBO_CLIENT_SECRET", "QBO_ENV (sandbox|production)"],
  xero: ["XERO_CLIENT_ID", "XERO_CLIENT_SECRET"],
  simulated: [],
};

export function describeLiveProviders(): LiveProviderInfo[] {
  return (Object.keys(PROVIDERS) as LiveAccountingProviderId[]).map((id) => {
    const p = PROVIDERS[id];
    const encryptionOk = id === "simulated" || isEncryptionConfigured();
    const configured = p.configured() && encryptionOk;
    const reason = !p.configured() ? p.unavailableReason() : encryptionOk ? null : "Set CREDENTIAL_ENCRYPTION_KEY so accounting tokens can be stored encrypted.";
    return { id, label: p.label, configured, reason, env: ENV_HINTS[id] };
  });
}

// ── Settings ─────────────────────────────────────────────────────────────────

export function parseSettings(raw: string | null | undefined): AccountingSettings {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as AccountingSettings) : {};
  } catch {
    return {};
  }
}

export function toContext(row: AccountingConnectionRow): ConnectionContext {
  return { id: row.id, realmId: row.realm_id, tenantId: row.tenant_id, settings: parseSettings(row.settings) };
}

// ── Auth ─────────────────────────────────────────────────────────────────────

export function serializeAuth(auth: AccountingAuth, provider: LiveAccountingProviderId): string | null {
  if (provider === "simulated") return null;
  if (!isEncryptionConfigured()) throw new Error("CREDENTIAL_ENCRYPTION_KEY is not set — cannot store accounting credentials.");
  return encryptSecret(JSON.stringify(auth ?? {}));
}

export function readAuth(row: Pick<AccountingConnectionRow, "auth" | "provider">): AccountingAuth {
  if (!row.auth) return {};
  const plain = decryptSecret(row.auth);
  if (!plain) throw new Error("Stored accounting credentials could not be decrypted — reconnect the integration.");
  try {
    return JSON.parse(plain) as AccountingAuth;
  } catch {
    return {};
  }
}

/** Refresh the access token when it is about to expire; persists the new auth. */
export async function ensureFreshAuth(row: AccountingConnectionRow): Promise<AccountingAuth> {
  const provider = getLiveProvider(row.provider);
  if (!provider) throw new Error(`Unknown accounting provider ${row.provider}`);
  const auth = readAuth(row);
  if (row.provider === "simulated") return auth;
  if (auth.access_token && (auth.expires_at ?? 0) > Date.now() + 60_000) return auth;
  const next = await provider.refresh(auth);
  await query(`UPDATE accounting_connections SET auth = $1 WHERE id = $2`, [serializeAuth(next, row.provider), row.id]);
  return next;
}

// ── Connections ──────────────────────────────────────────────────────────────

const CONN_COLS = `id, user_id, provider, auth, realm_id, tenant_id, company_name, status, sync_cursor, last_sync_at, last_error, settings, created_at`;

export async function listConnections(dataId: string): Promise<AccountingConnectionView[]> {
  const rows = await query<AccountingConnectionRow & { linked: string | number | null; errors: string | number | null }>(
    `SELECT c.id, c.user_id, c.provider, NULL AS auth, c.realm_id, c.tenant_id, c.company_name, c.status, c.sync_cursor, c.last_sync_at, c.last_error, c.settings, c.created_at,
            (SELECT COUNT(*) FROM accounting_links l WHERE l.connection_id = c.id AND l.remote_id IS NOT NULL) AS linked,
            (SELECT COUNT(*) FROM accounting_links l WHERE l.connection_id = c.id AND l.error IS NOT NULL) AS errors
       FROM accounting_connections c WHERE c.user_id = $1 ORDER BY c.created_at ASC`,
    [dataId]
  );
  return rows.map((r) => ({
    id: r.id, provider: r.provider, realm_id: r.realm_id, tenant_id: r.tenant_id, company_name: r.company_name, status: r.status,
    last_sync_at: r.last_sync_at, last_error: r.last_error, settings: parseSettings(r.settings), created_at: r.created_at,
    counts: { linked: Number(r.linked ?? 0) || 0, errors: Number(r.errors ?? 0) || 0 },
  }));
}

export async function getConnection(dataId: string, id: string): Promise<AccountingConnectionRow | null> {
  return queryOne<AccountingConnectionRow>(`SELECT ${CONN_COLS} FROM accounting_connections WHERE id = $1 AND user_id = $2`, [id, dataId]);
}

/** Internal (cron) lookup without a tenant check — callers must trust the id source. */
export async function getConnectionById(id: string): Promise<AccountingConnectionRow | null> {
  return queryOne<AccountingConnectionRow>(`SELECT ${CONN_COLS} FROM accounting_connections WHERE id = $1`, [id]);
}

export async function listConnectedForUser(dataId: string): Promise<AccountingConnectionRow[]> {
  return query<AccountingConnectionRow>(`SELECT ${CONN_COLS} FROM accounting_connections WHERE user_id = $1 AND status = 'connected' ORDER BY created_at ASC`, [dataId]);
}

export async function listAllConnected(limit = 100): Promise<AccountingConnectionRow[]> {
  return query<AccountingConnectionRow>(`SELECT ${CONN_COLS} FROM accounting_connections WHERE status = 'connected' ORDER BY COALESCE(last_sync_at, 'epoch'::timestamptz) ASC LIMIT $1`, [limit]);
}

export async function upsertConnection(
  dataId: string,
  input: { provider: LiveAccountingProviderId; auth: AccountingAuth; realmId: string | null; tenantId: string | null; companyName: string | null }
): Promise<string> {
  const authEnc = serializeAuth(input.auth, input.provider);
  // One connection per (org, provider, company).
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM accounting_connections WHERE user_id = $1 AND provider = $2 AND COALESCE(realm_id, '') = $3 AND COALESCE(tenant_id, '') = $4`,
    [dataId, input.provider, input.realmId ?? "", input.tenantId ?? ""]
  );
  if (existing) {
    await query(
      `UPDATE accounting_connections SET auth = $1, company_name = COALESCE($2, company_name), status = 'connected', last_error = NULL WHERE id = $3`,
      [authEnc, input.companyName, existing.id]
    );
    return existing.id;
  }
  const id = randomUUID();
  await query(
    `INSERT INTO accounting_connections (id, user_id, provider, auth, realm_id, tenant_id, company_name, status, settings, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'connected', $8, NOW())`,
    [id, dataId, input.provider, authEnc, input.realmId, input.tenantId, input.companyName, JSON.stringify({ push_payments: true, push_expenses: true })]
  );
  return id;
}

export async function updateConnectionSettings(dataId: string, id: string, patch: { settings?: AccountingSettings; status?: "connected" | "disabled" }): Promise<AccountingConnectionRow | null> {
  const row = await getConnection(dataId, id);
  if (!row) return null;
  const settings = patch.settings ? { ...parseSettings(row.settings), ...patch.settings } : parseSettings(row.settings);
  const status = patch.status ?? (row.status === "error" ? "connected" : row.status);
  await query(`UPDATE accounting_connections SET settings = $1, status = $2, last_error = CASE WHEN $2 = 'connected' THEN NULL ELSE last_error END WHERE id = $3 AND user_id = $4`, [
    JSON.stringify(settings), status, id, dataId,
  ]);
  return getConnection(dataId, id);
}

export async function markConnectionSynced(id: string, cursor: string | null | undefined): Promise<void> {
  if (cursor === undefined) await query(`UPDATE accounting_connections SET last_sync_at = NOW(), last_error = NULL, status = 'connected' WHERE id = $1`, [id]);
  else await query(`UPDATE accounting_connections SET last_sync_at = NOW(), last_error = NULL, status = 'connected', sync_cursor = $2 WHERE id = $1`, [id, cursor]);
}

export async function markConnectionError(id: string, message: string, fatal = false): Promise<void> {
  await query(`UPDATE accounting_connections SET last_error = $2, status = CASE WHEN $3 THEN 'error' ELSE status END WHERE id = $1`, [id, message.slice(0, 1000), fatal]);
}

export async function deleteConnection(dataId: string, id: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(`SELECT id FROM accounting_connections WHERE id = $1 AND user_id = $2`, [id, dataId]);
  if (!row) return false;
  await query(`DELETE FROM accounting_links WHERE connection_id = $1 AND user_id = $2`, [id, dataId]);
  await query(`DELETE FROM accounting_sync_log WHERE connection_id = $1 AND user_id = $2`, [id, dataId]);
  await query(`DELETE FROM accounting_sim_objects WHERE connection_id = $1 AND user_id = $2`, [id, dataId]);
  await query(`DELETE FROM accounting_connections WHERE id = $1 AND user_id = $2`, [id, dataId]);
  return true;
}

// ── Links ────────────────────────────────────────────────────────────────────

const LINK_COLS = `id, user_id, connection_id, entity_kind, entity_id, remote_id, remote_updated_at, remote_meta, last_pushed_at, last_pulled_at, hash, error, created_at`;

export async function getLink(connId: string, kind: AccountingEntityKind, entityId: string): Promise<AccountingLinkRow | null> {
  return queryOne<AccountingLinkRow>(`SELECT ${LINK_COLS} FROM accounting_links WHERE connection_id = $1 AND entity_kind = $2 AND entity_id = $3`, [connId, kind, entityId]);
}

export async function getLinkByRemote(connId: string, kind: AccountingEntityKind, remoteId: string): Promise<AccountingLinkRow | null> {
  return queryOne<AccountingLinkRow>(`SELECT ${LINK_COLS} FROM accounting_links WHERE connection_id = $1 AND entity_kind = $2 AND remote_id = $3`, [connId, kind, remoteId]);
}

export async function upsertLink(
  userId: string, connId: string, kind: AccountingEntityKind, entityId: string,
  patch: { remote_id?: string | null; remote_updated_at?: string | null; remote_meta?: Record<string, string> | null; hash?: string | null; error?: string | null; pushed?: boolean; pulled?: boolean }
): Promise<void> {
  const existing = await getLink(connId, kind, entityId);
  const meta = patch.remote_meta === undefined ? undefined : patch.remote_meta ? JSON.stringify(patch.remote_meta) : null;
  if (!existing) {
    await query(
      `INSERT INTO accounting_links (id, user_id, connection_id, entity_kind, entity_id, remote_id, remote_updated_at, remote_meta, last_pushed_at, last_pulled_at, hash, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $9 THEN NOW() ELSE NULL END, CASE WHEN $10 THEN NOW() ELSE NULL END, $11, $12)`,
      [randomUUID(), userId, connId, kind, entityId, patch.remote_id ?? null, patch.remote_updated_at ?? null, meta ?? null, Boolean(patch.pushed), Boolean(patch.pulled), patch.hash ?? null, patch.error ?? null]
    );
    return;
  }
  const sets: string[] = [];
  const params: unknown[] = [existing.id];
  const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
  if (patch.remote_id !== undefined) set("remote_id", patch.remote_id);
  if (patch.remote_updated_at !== undefined) set("remote_updated_at", patch.remote_updated_at);
  if (meta !== undefined) set("remote_meta", meta);
  if (patch.hash !== undefined) set("hash", patch.hash);
  if (patch.error !== undefined) set("error", patch.error);
  if (patch.pushed) sets.push("last_pushed_at = NOW()");
  if (patch.pulled) sets.push("last_pulled_at = NOW()");
  if (sets.length === 0) return;
  await query(`UPDATE accounting_links SET ${sets.join(", ")} WHERE id = $1`, params);
}

export interface LinkSummary {
  entity_id: string;
  connection_id: string;
  provider: LiveAccountingProviderId;
  remote_id: string | null;
  last_pushed_at: string | null;
  error: string | null;
  /** synced | pending | error */
  state: "synced" | "pending" | "error";
}

export async function listLinks(dataId: string, kind: AccountingEntityKind, opts: { connectionId?: string | null; limit?: number } = {}): Promise<LinkSummary[]> {
  const params: unknown[] = [dataId, kind];
  let sql = `SELECT l.entity_id, l.connection_id, c.provider, l.remote_id, l.last_pushed_at, l.error
               FROM accounting_links l JOIN accounting_connections c ON c.id = l.connection_id
              WHERE l.user_id = $1 AND l.entity_kind = $2`;
  if (opts.connectionId) { params.push(opts.connectionId); sql += ` AND l.connection_id = $${params.length}`; }
  params.push(Math.min(Math.max(opts.limit ?? 500, 1), 2000));
  sql += ` ORDER BY l.created_at DESC LIMIT $${params.length}`;
  const rows = await query<Omit<LinkSummary, "state">>(sql, params);
  return rows.map((r) => ({ ...r, state: r.error ? "error" : r.remote_id ? "synced" : "pending" }));
}

// ── Sync log ─────────────────────────────────────────────────────────────────

export async function logSync(userId: string, connId: string, entry: { direction: "push" | "pull"; kind?: string | null; entityId?: string | null; remoteId?: string | null; status: "ok" | "error" | "skipped"; message?: string | null }): Promise<void> {
  await query(
    `INSERT INTO accounting_sync_log (id, user_id, connection_id, direction, entity_kind, entity_id, remote_id, status, message) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [randomUUID(), userId, connId, entry.direction, entry.kind ?? null, entry.entityId ?? null, entry.remoteId ?? null, entry.status, entry.message?.slice(0, 2000) ?? null]
  ).catch((err) => console.error("[accounting] log write failed:", err));
}

export async function listSyncLog(dataId: string, connId: string, opts: { status?: string | null; direction?: string | null; kind?: string | null; limit?: number } = {}): Promise<AccountingSyncLogRow[]> {
  const params: unknown[] = [dataId, connId];
  let sql = `SELECT id, connection_id, direction, entity_kind, entity_id, remote_id, status, message, created_at FROM accounting_sync_log WHERE user_id = $1 AND connection_id = $2`;
  if (opts.status) { params.push(opts.status); sql += ` AND status = $${params.length}`; }
  if (opts.direction) { params.push(opts.direction); sql += ` AND direction = $${params.length}`; }
  if (opts.kind) { params.push(opts.kind); sql += ` AND entity_kind = $${params.length}`; }
  params.push(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;
  return query<AccountingSyncLogRow>(sql, params);
}
