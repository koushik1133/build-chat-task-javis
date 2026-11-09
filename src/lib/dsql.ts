/**
 * Aurora DSQL client — serverless, PostgreSQL-compatible distributed SQL.
 *
 * Data model:
 *   chats            — chat metadata (title, timestamps)
 *   tasks            — extracted action items, linked to chats
 *   files            — RAG file metadata (bodies stored in Supabase Storage)
 *   sites            — AI-generated site HTML + plan
 *   site_revisions   — version history for each site
 *   site_leads       — form submissions captured from published sites
 *
 * IAM auth is handled automatically by AuroraDSQLPool via the official
 * AWS Aurora DSQL Node.js connector (@aws/aurora-dsql-node-postgres-connector).
 * Tokens are refreshed transparently before each connection checkout.
 *
 * DSQL constraints observed throughout:
 *   - No foreign key constraints → application-layer referential integrity
 *   - JSON stored as TEXT → JSON.stringify / JSON.parse in application code
 *   - CREATE INDEX ASYNC only (schema migration)
 *   - One DDL statement per transaction
 */

import { Pool } from "pg";
import { AuroraDSQLPool } from "@aws/aurora-dsql-node-postgres-connector";
import type { PoolClient, QueryResultRow } from "pg";

let _pool: Pool | AuroraDSQLPool | null = null;

function getPool(): Pool | AuroraDSQLPool {
  if (_pool) return _pool;

  const host = process.env.DSQL_ENDPOINT;
  if (!host) {
    throw new Error(
      "DSQL_ENDPOINT is not set. Add your Aurora DSQL cluster endpoint to environment variables."
    );
  }

  if (host === "localhost" || host === "127.0.0.1") {
    _pool = new Pool({
      host,
      port: 5432,
      database: process.env.DB_NAME || "postgres",
      user: process.env.DB_USER || "postgres",
      password: process.env.DB_PASSWORD || "",
      max: 10,
      idleTimeoutMillis: 30_000,
    });
  } else {
    _pool = new AuroraDSQLPool({
      host,
      database: "postgres",
      max: 10,
      idleTimeoutMillis: 30_000,
      ssl: { rejectUnauthorized: false },
    });
  }

  return _pool;
}


// ─── Errors & retry ───────────────────────────────────────────────────────────

/** Thrown when a database query fails. Wraps the underlying pg error. */
export class DbError extends Error {
  readonly code: string | undefined;
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "DbError";
    this.cause = cause;
    this.code =
      cause && typeof cause === "object" && "code" in cause
        ? String((cause as { code: unknown }).code)
        : undefined;
  }
}

export function isDbError(e: unknown): e is DbError {
  return e instanceof DbError || (e instanceof Error && e.name === "DbError");
}

/**
 * Postgres 42703 (undefined_column): the query named a column the deployed
 * schema does not have yet. Callers use it to fall back to a pre-migration
 * statement without swallowing unrelated failures.
 */
export function isUndefinedColumn(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = "code" in err ? String((err as { code?: unknown }).code ?? "") : "";
  const cause = "cause" in err ? (err as { cause?: { code?: unknown } }).cause : null;
  const message = err instanceof Error ? err.message : "";
  return code === "42703" || String(cause?.code ?? "") === "42703" || /column .* does not exist/i.test(message);
}

/** True for DSQL optimistic-concurrency conflicts (retryable). */
function isConcurrencyConflict(e: unknown): boolean {
  const err = isDbError(e) ? e.cause : e;
  if (!err || typeof err !== "object") return false;
  const code = "code" in err ? String((err as { code: unknown }).code) : "";
  const msg = "message" in err ? String((err as { message: unknown }).message) : "";
  return (
    code === "40001" ||
    msg.includes("OC000") ||
    msg.toLowerCase().includes("serialization")
  );
}

/** Retry `fn` on DSQL optimistic-concurrency conflicts with small backoff. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isConcurrencyConflict(e) || i === attempts - 1) throw e;
      const delay = 50 * 2 ** i + Math.floor(Math.random() * 50);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/** Run a parameterised query and return all rows. Throws DbError on failure. */
export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  values: unknown[] = []
): Promise<T[]> {
  try {
    const pool = getPool();
    const result = await pool.query<T>(sql, values);
    return result.rows;
  } catch (err) {
    console.error("[DSQL Query Error]", sql, values, err);
    throw new DbError(err instanceof Error ? err.message : String(err), err);
  }
}

/** Run a parameterised query and return the first row (or null). */
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  values: unknown[] = []
): Promise<T | null> {
  const rows = await query<T>(sql, values);
  return rows[0] ?? null;
}

/** Run multiple statements inside one transaction. */
export async function transaction(
  fn: (client: PoolClient) => Promise<void>
): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await fn(client);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ─── Type helpers ─────────────────────────────────────────────────────────────

export type DbChat = {
  id: string;
  user_id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

export type DbTask = {
  id: string;
  user_id: string;
  chat_id: string | null;
  title: string;
  done: boolean;
  created_at: string;
};

export type DbFile = {
  id: string;
  user_id: string;
  name: string;
  mime: string | null;
  size_bytes: number | null;
  storage_path: string | null;
  chunk_count: number;
  created_at: string;
};

export type DbSite = {
  id: string;
  user_id: string;
  title: string;
  persona: string | null;
  plan: string | null;
  html: string;
  created_at: string;
  updated_at: string;
};

export type DbSiteRevision = {
  id: string;
  site_id: string;
  user_id: string;
  source: string;
  prompt: string | null;
  html: string;
  created_at: string;
};

export type DbSiteLead = {
  id: string;
  site_id: string;
  data: string;
  created_at: string;
};
