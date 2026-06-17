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
const statements = sql
  .split(";")
  .map(s => s.replace(/--[^\n]*/g, "").trim())
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

if (!DSQL_ENDPOINT) {
  console.error("✗ DSQL_ENDPOINT is not set in .env.local");
  process.exit(1);
}

// Dynamically import pg and DSQL auth connector
const { default: pg } = await import("pg");
const { DsqlSigner } = await import("@aws-sdk/dsql-signer").catch(() => {
  return import("@aws/aurora-dsql-node-postgres-connector");
});

const signer = new DsqlSigner({
  hostname: DSQL_ENDPOINT,
  region:   AWS_REGION,
});

const token = await signer.getDbConnectAdminAuthToken();

const client = new pg.Client({
  host:     DSQL_ENDPOINT,
  user:     "admin",
  password: token,
  database: "postgres",
  port:     5432,
  ssl:      { rejectUnauthorized: false },
});

await client.connect();
console.log(`Connected to DSQL: ${DSQL_ENDPOINT}\n`);
console.log(`Found ${statements.length} migration statements\n`);

let ok = 0, skip = 0, fail = 0;

for (const stmt of statements) {
  const preview = stmt.replace(/\s+/g, " ").slice(0, 80);
  try {
    await client.query(stmt);
    console.log(`  ✓  ${preview}`);
    ok++;
  } catch (err) {
    const msg = err?.message ?? String(err);
    // DSQL returns "column already exists" for ADD COLUMN IF NOT EXISTS — safe to skip
    if (msg.includes("already exists") || msg.includes("does not exist")) {
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
