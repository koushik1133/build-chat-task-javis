#!/usr/bin/env node
/**
 * Local agent worker — POSTs to /api/cron/agents every 5s so queued agent
 * runs, approvals resumes and playbook jobs are processed while `next dev`
 * is running. Ctrl-C to stop.
 *
 * Run manually:   node scripts/run-agent-worker.mjs
 * Suggested npm script (add to package.json yourself):
 *   "worker:agents": "node scripts/run-agent-worker.mjs"
 *
 * Reads CRON_SECRET (and optionally NEXT_PUBLIC_APP_URL) from .env.local.
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(root, ".env.local");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

const URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3001";
const SECRET = process.env.CRON_SECRET;
const INTERVAL_MS = 5_000;

if (!SECRET) {
  console.error("CRON_SECRET is not set in .env.local — the worker cannot authenticate.");
  process.exit(1);
}

let inFlight = false;

async function tick() {
  if (inFlight) return; // a long tick (up to ~45s) must not overlap the next one
  inFlight = true;
  const ts = () => new Date().toLocaleTimeString(undefined, { hour12: false });
  try {
    const res = await fetch(`${URL}/api/cron/agents`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
      signal: AbortSignal.timeout(65_000),
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 200) };
    }
    if (!res.ok) {
      console.error(`[${ts()}] ✗ worker tick error (${res.status}):`, data);
    } else if (data.promoted || data.claimed || data.failed || data.dead) {
      console.log(
        `[${ts()}] promoted=${data.promoted} claimed=${data.claimed} done=${data.done} failed=${data.failed} dead=${data.dead} (${data.ms}ms)`
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${ts()}] ✗ worker unreachable — is the dev server running on ${URL}?`, msg);
  } finally {
    inFlight = false;
  }
}

console.log(`KernelHub agent worker → ${URL}/api/cron/agents every ${INTERVAL_MS / 1000}s (Ctrl-C to stop)`);
console.log(`CRON_SECRET: ${SECRET.slice(0, 6)}…`);

process.on("SIGINT", () => {
  console.log("\nworker stopped");
  process.exit(0);
});

tick();
setInterval(tick, INTERVAL_MS);
