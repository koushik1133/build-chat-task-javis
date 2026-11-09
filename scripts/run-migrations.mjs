#!/usr/bin/env node
/**
 * Javis — Aurora DSQL migration runner
 *
 * Reads aws/migrations.sql and runs each DDL/DML statement individually
 * (DSQL requires one DDL per transaction).
 *
 * Usage:
 *   node scripts/run-migrations.mjs
 *   node scripts/run-migrations.mjs --dry-run   (print statements without executing)
 */

import { readFileSync, existsSync } from "fs";
import { createHash } from "crypto";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// Load .env.local
const envFile = join(ROOT, ".env.local");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
}

const isDryRun = process.argv.includes("--dry-run");

const sql = readFileSync(join(ROOT, "aws/migrations.sql"), "utf8");

// Split on semicolons, keep non-empty statements, strip comments
// Strip line comments BEFORE splitting, so a ";" inside a comment can't
// become a statement boundary.
const statements = sql
  .replace(/--[^\n]*/g, "")
  .split(";")
  .map(s => s.trim())
  .filter(Boolean);

if (isDryRun) {
  console.log(`Found ${statements.length} migration statements (DRY RUN)\n`);
  for (const stmt of statements) {
    console.log(`  [dry] ${stmt.replace(/\s+/g, " ").slice(0, 100)}`);
  }
  console.log("\nDry run complete — no statements executed.");
  process.exit(0);
}

const DSQL_ENDPOINT = process.env.DSQL_ENDPOINT;
const AWS_REGION    = process.env.AWS_REGION ?? "us-east-2";
const isLocal = DSQL_ENDPOINT === "localhost" || DSQL_ENDPOINT === "127.0.0.1";

/** Normalise whitespace so cosmetic edits don't re-run a statement. */
const normalise = (stmt) => stmt.replace(/\s+/g, " ").trim();
const hashOf = (stmt) => createHash("sha256").update(normalise(stmt)).digest("hex");

if (!DSQL_ENDPOINT) {
  console.error("✗ DSQL_ENDPOINT is not set in .env.local");
  process.exit(1);
}

// Dynamically import pg and DSQL auth connector
const { default: pg } = await import("pg");

let client;
if (isLocal) {
  client = new pg.Client({
    host:     DSQL_ENDPOINT,
    user:     process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "postgres",
    port:     5432,
  });
} else {
  const { DsqlSigner } = await import("@aws-sdk/dsql-signer").catch(() => {
    return import("@aws/aurora-dsql-node-postgres-connector");
  });

  const signer = new DsqlSigner({
    hostname: DSQL_ENDPOINT,
    region:   AWS_REGION,
  });

  const token = await signer.getDbConnectAdminAuthToken();

  client = new pg.Client({
    host:     DSQL_ENDPOINT,
    user:     "admin",
    password: token,
    database: "postgres",
    port:     5432,
    ssl:      { rejectUnauthorized: false },
  });
}

await client.connect();

console.log(`Connected to DSQL: ${DSQL_ENDPOINT}\n`);
console.log(`Found ${statements.length} migration statements\n`);

await client.query(
  "CREATE TABLE IF NOT EXISTS schema_migrations (hash TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())"
);
const applied = new Set(
  (await client.query("SELECT hash FROM schema_migrations")).rows.map((r) => r.hash)
);


/** Poll sys.jobs until an async index build finishes (best effort: polling problems only warn). */
async function awaitIndexJob(jobId, timeoutMs = 5 * 60_000) {
  if (!jobId) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let row;
    try {
      row = (await client.query("SELECT status, details FROM sys.jobs WHERE job_id = $1", [jobId])).rows[0];
    } catch (e) {
      console.warn(`     (could not poll sys.jobs: ${e?.message ?? e}; continuing)`);
      return;
    }
    const status = String(row?.status ?? "").toLowerCase();
    if (status === "completed") return;
    if (status === "failed") throw new Error(`index job ${jobId} failed: ${row?.details ?? "no details"}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`index job ${jobId} did not finish within ${timeoutMs / 1000}s`);
}

let ok = 0, skip = 0, fail = 0;

for (const rawStmt of statements) {
  // Local Postgres has no CREATE [UNIQUE] INDEX ASYNC — strip the DSQL-only keyword.
  const stmt = isLocal ? rawStmt.replace(/CREATE\s+(UNIQUE\s+)?INDEX\s+ASYNC/gi, "CREATE $1INDEX") : rawStmt;
  const hash = hashOf(rawStmt);
  const preview = stmt.replace(/\s+/g, " ").slice(0, 80);
  if (applied.has(hash)) {
    console.log(`  ⟳  ${preview}`);
    skip++;
    continue;
  }
  try {
    const res = await client.query(stmt);
    // DSQL runs CREATE INDEX ASYNC as a background job and returns its job_id immediately. Wait for it so
    // a failed build (e.g. duplicate data under a UNIQUE index) is not recorded as applied.
    if (!isLocal && /CREATE\s+(UNIQUE\s+)?INDEX\s+ASYNC/i.test(rawStmt)) {
      await awaitIndexJob(res?.rows?.[0]?.job_id);
    }
    await client.query("INSERT INTO schema_migrations (hash) VALUES ($1)", [hash]);
    console.log(`  ✓  ${preview}`);
    ok++;
  } catch (err) {
    const msg = err?.message ?? String(err);
    // DSQL returns "column already exists" for ADD COLUMN IF NOT EXISTS — safe to skip
    if (msg.includes("already exists") || msg.includes("does not exist")) {
      await client.query("INSERT INTO schema_migrations (hash) VALUES ($1) ON CONFLICT DO NOTHING", [hash]).catch(() => {});
      console.log(`  ⟳  ${preview}`);
      skip++;
    } else {
      console.error(`  ✗  ${preview}`);
      console.error(`     ${msg}`);
      fail++;
    }
  }
}

await client.end();

console.log(`\nDone — ${ok} applied, ${skip} already up-to-date, ${fail} failed`);
if (fail > 0) process.exit(1);
