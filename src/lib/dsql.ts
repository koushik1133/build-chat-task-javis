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

import { AuroraDSQLPool } from "@aws/aurora-dsql-node-postgres-connector";
import type { PoolClient, QueryResultRow } from "pg";

let _pool: AuroraDSQLPool | null = null;

function getPool(): AuroraDSQLPool {
  if (_pool) return _pool;

  const host = process.env.DSQL_ENDPOINT;
  if (!host) {
    throw new Error(
      "DSQL_ENDPOINT is not set. Add your Aurora DSQL cluster endpoint to environment variables."
    );
  }

  _pool = new AuroraDSQLPool({
    host,
    database: "postgres",
    max: 10,
    idleTimeoutMillis: 30_000,
    ssl: { rejectUnauthorized: false },
  });

  return _pool;
}

/** Run a parameterised query and return all rows. */
export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  values: unknown[] = []
): Promise<T[]> {
  const pool = getPool();
  const result = await pool.query<T>(sql, values);
  return result.rows;
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
