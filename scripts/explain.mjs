#!/usr/bin/env node
/**
 * EXPLAIN (no ANALYZE) the hottest KernelHub list queries against local
 * Postgres and report whether each one is served by an index scan.
 *
 *   node scripts/explain.mjs            # uses .env.local (DB_USER, DB_NAME, DB_PASSWORD)
 *   node scripts/explain.mjs --json     # machine-readable
 *
 * Apply aws/phase6/d.sql first (`sed 's/ ASYNC//g' aws/phase6/d.sql | psql …`).
 * Exit code 1 when a query falls back to a sequential scan on a table that has
 * rows, so it can run in CI against a seeded database.
 */
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function loadEnv() {
  const file = join(root, ".env.local");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnv();

const DATA = "00000000-0000-0000-0000-000000000000";
const TS = new Date().toISOString();
const KEYSET = (col = "created_at") =>
  `(date_trunc('milliseconds', ${col}) < $2 OR (date_trunc('milliseconds', ${col}) = $2 AND id::text < $3)) ORDER BY date_trunc('milliseconds', ${col}) DESC, id DESC`;

/** The 10 hottest list/lookup shapes (see docs/PERFORMANCE.md). */
const QUERIES = [
  { name: "crm_contacts list (keyset)", table: "crm_contacts", sql: `SELECT * FROM crm_contacts WHERE user_id = $1 AND ${KEYSET()} LIMIT 51`, params: [DATA, TS, "z"] },
  { name: "tickets active (keyset)", table: "tickets", sql: `SELECT id FROM tickets WHERE user_id = $1 AND status IN ('open','pending') AND ${KEYSET()} LIMIT 51`, params: [DATA, TS, "z"] },
  { name: "records by type (keyset)", table: "records", sql: `SELECT id FROM records WHERE user_id = $1 AND type_id = 'type' AND deleted_at IS NULL AND ${KEYSET()} LIMIT 51`, params: [DATA, TS, "z"] },
  { name: "products active (keyset)", table: "products", sql: `SELECT id FROM products WHERE user_id = $1 AND deleted_at IS NULL AND active = TRUE AND ${KEYSET()} LIMIT 51`, params: [DATA, TS, "z"] },
  { name: "expenses (keyset)", table: "expenses", sql: `SELECT id FROM expenses WHERE user_id = $1 AND ${KEYSET()} LIMIT 51`, params: [DATA, TS, "z"] },
  { name: "time_entries (keyset)", table: "time_entries", sql: `SELECT id FROM time_entries WHERE user_id = $1 AND ${KEYSET()} LIMIT 51`, params: [DATA, TS, "z"] },
  { name: "tasks (keyset)", table: "tasks", sql: `SELECT id FROM tasks WHERE user_id = $1 AND ${KEYSET("(created_at AT TIME ZONE 'UTC')")} LIMIT 51`, params: [DATA, TS, "z"] },
  { name: "audit_log timeline (keyset)", table: "audit_log", sql: `SELECT id FROM audit_log WHERE user_id = $1 AND ${KEYSET()} LIMIT 51`, params: [DATA, TS, "z"] },
  { name: "outbox unread in-app (bell)", table: "notification_outbox", sql: `SELECT id FROM notification_outbox WHERE user_id = $1 AND channel = 'in_app' AND status = 'sent' AND read_at IS NULL ORDER BY date_trunc('milliseconds', created_at) DESC, id DESC LIMIT 31`, params: [DATA] },
  { name: "requireScope membership join", table: "memberships", sql: `SELECT o.owner_user_id FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = $1 AND m.org_id = $2 AND m.status = 'active'`, params: [DATA, "org"] },
];

function usesIndex(plan) {
  const s = JSON.stringify(plan);
  return /Index (Only )?Scan|Bitmap Index Scan/.test(s);
}
function indexNames(plan) {
  const out = new Set();
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n["Index Name"]) out.add(n["Index Name"]);
    Object.values(n).forEach(walk);
  };
  walk(plan);
  return [...out];
}

async function main() {
  const json = process.argv.includes("--json");
  const client = new pg.Client({
    host: process.env.DSQL_ENDPOINT && process.env.DSQL_ENDPOINT !== "localhost" && process.env.DSQL_ENDPOINT !== "127.0.0.1" ? "127.0.0.1" : "127.0.0.1",
    port: 5432,
    user: process.env.DB_USER || "postgres",
    database: process.env.DB_NAME || "postgres",
    password: process.env.DB_PASSWORD || undefined,
  });
  await client.connect();
  const results = [];
  let failures = 0;
  for (const q of QUERIES) {
    try {
      const { rows } = await client.query(`EXPLAIN (FORMAT JSON) ${q.sql}`, q.params);
      const plan = rows[0]["QUERY PLAN"];
      const count = Number((await client.query(`SELECT reltuples::bigint AS n FROM pg_class WHERE relname = $1`, [q.table])).rows[0]?.n ?? 0);
      const indexed = usesIndex(plan);
      const ok = indexed || count < 1_000; // a seq scan on a tiny table is the planner being sensible
      if (!ok) failures++;
      results.push({ name: q.name, table: q.table, indexed, indexes: indexNames(plan), estRows: count, ok });
    } catch (err) {
      failures++;
      results.push({ name: q.name, table: q.table, error: err instanceof Error ? err.message : String(err), ok: false });
    }
  }
  await client.end();
  if (json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) {
      const mark = r.ok ? "OK " : "!! ";
      if (r.error) console.log(`${mark}${r.name.padEnd(34)} ERROR ${r.error}`);
      else console.log(`${mark}${r.name.padEnd(34)} ${r.indexed ? "index scan" : "seq scan  "} ${r.indexes.join(", ") || "-"}  (~${r.estRows} rows)`);
    }
    console.log(`\n${results.length - failures}/${results.length} queries indexed or on tables too small to matter (<1k rows).`);
  }
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
