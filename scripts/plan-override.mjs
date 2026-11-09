#!/usr/bin/env node
/**
 * KernelHub plan overrides (support / enterprise exceptions). No UI by design.
 *
 *   node scripts/plan-override.mjs show   <dataId>
 *   node scripts/plan-override.mjs set    <dataId> --reason "Pilot customer" [--plan scale]
 *                                         [--limit contacts=100000 --limit seats=unlimited ...]
 *                                         [--feature sso_scim=true --feature white_label=false ...]
 *   node scripts/plan-override.mjs clear  <dataId>
 *
 * <dataId> is the organisation's owner_user_id (the user_id on every table).
 * Limits: seats, child_workspaces, contacts, ai_credits_included_per_month,
 * storage_mb, api_rate_limit_per_min, api_keys ("unlimited" = no cap).
 * Features: automations_v2, marketplace_publish, sso_scim, white_label,
 * accounting_sync, advanced_reports, webchat_widget, voice_campaigns,
 * custom_domain, priority_support.
 * Connects with the same env as scripts/run-migrations.mjs (.env.local).
 */
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(ROOT, ".env.local");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
}

const PLANS = ["free", "starter", "growth", "scale", "enterprise"];
const LIMITS = ["seats", "child_workspaces", "contacts", "ai_credits_included_per_month", "storage_mb", "api_rate_limit_per_min", "api_keys"];
const FEATURES = ["automations_v2", "marketplace_publish", "sso_scim", "white_label", "accounting_sync", "advanced_reports", "webchat_widget", "voice_campaigns", "custom_domain", "priority_support"];

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].replace(/^#!.*\n/, ""));
  process.exit(1);
}

const [cmd, dataId, ...rest] = process.argv.slice(2);
if (!["show", "set", "clear"].includes(cmd ?? "") || !dataId) usage();

const opts = { limits: {}, features: {}, plan: undefined, reason: undefined };
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  const v = rest[++i];
  if (v === undefined) usage(`missing value for ${a}`);
  if (a === "--plan") {
    if (!PLANS.includes(v)) usage(`unknown plan ${v}`);
    opts.plan = v;
  } else if (a === "--reason") opts.reason = v;
  else if (a === "--limit") {
    const [k, raw] = v.split("=");
    if (!LIMITS.includes(k)) usage(`unknown limit ${k}`);
    if (raw === "unlimited") opts.limits[k] = null;
    else if (/^\d+$/.test(raw ?? "")) opts.limits[k] = Number(raw);
    else usage(`bad value for ${k}`);
  } else if (a === "--feature") {
    const [k, raw] = v.split("=");
    if (!FEATURES.includes(k)) usage(`unknown feature ${k}`);
    if (raw !== "true" && raw !== "false") usage(`feature ${k} must be true or false`);
    opts.features[k] = raw === "true";
  } else usage(`unknown flag ${a}`);
}

const host = process.env.DSQL_ENDPOINT;
if (!host) usage("DSQL_ENDPOINT is not set");
const { default: pg } = await import("pg");
let client;
if (host === "localhost" || host === "127.0.0.1") {
  client = new pg.Client({ host, user: process.env.DB_USER || "postgres", password: process.env.DB_PASSWORD || "", database: process.env.DB_NAME || "postgres", port: 5432 });
} else {
  const { DsqlSigner } = await import("@aws-sdk/dsql-signer").catch(() => import("@aws/aurora-dsql-node-postgres-connector"));
  const token = await new DsqlSigner({ hostname: host, region: process.env.AWS_REGION ?? "us-east-2" }).getDbConnectAdminAuthToken();
  client = new pg.Client({ host, user: "admin", password: token, database: "postgres", port: 5432, ssl: { rejectUnauthorized: true } });
}
await client.connect();
try {
  if (cmd === "show") {
    const r = await client.query("SELECT * FROM plan_overrides WHERE user_id = $1", [dataId]);
    console.log(r.rows[0] ?? "no override");
  } else if (cmd === "clear") {
    const r = await client.query("DELETE FROM plan_overrides WHERE user_id = $1", [dataId]);
    console.log(`cleared (${r.rowCount})`);
  } else {
    if (!opts.reason) usage("--reason is required");
    const ent = {};
    if (opts.plan) ent.plan_key = opts.plan;
    if (Object.keys(opts.limits).length) ent.limits = opts.limits;
    if (Object.keys(opts.features).length) ent.features = opts.features;
    await client.query(
      `INSERT INTO plan_overrides (user_id, entitlements, reason, created_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET entitlements = EXCLUDED.entitlements, reason = EXCLUDED.reason, created_by = EXCLUDED.created_by, created_at = NOW()`,
      [dataId, JSON.stringify(ent), opts.reason, process.env.USER ?? "cli"]
    );
    console.log("override saved:", JSON.stringify(ent));
  }
} finally {
  await client.end();
}
