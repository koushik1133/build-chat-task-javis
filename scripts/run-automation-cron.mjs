#!/usr/bin/env node
/**
 * Automation scheduler — polls /api/cron/automations every 1 second (second-aligned).
 * Auto-started by `npm run dev`, or run manually: npm run cron:automations
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
const SECRET = process.env.CRON_SECRET ?? "dev-cron-secret-change-me";
/** 1s poll → scheduled 3:45 fires at ~3:45:01 */
const INTERVAL_MS = 1_000;

async function tick() {
  try {
    const res = await fetch(`${URL}/api/cron/automations`, {
      headers: { Authorization: `Bearer ${SECRET}` },
      // Fast actions (email/Slack) finish in ~1–3s; agent runs continue server-side.
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json();
    const ts = new Date().toLocaleTimeString(undefined, { hour12: false });
    if (data.ran?.length > 0) {
      for (const r of data.ran) {
        console.log(
          `[${ts}] ✓ ${r.name} — ${r.success ? "OK" : "FAIL"} (${r.latency_ms}ms) — ${r.message}`
        );
      }
    } else if (!res.ok) {
      console.error(`[${ts}] ✗ Cron error (${res.status}):`, data);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("aborted")) {
      console.error(`[${new Date().toLocaleTimeString()}] ✗ Cron unreachable — is npm run dev running?`, msg);
    }
  }
}

function msUntilNextSecond() {
  return 1000 - (Date.now() % 1000);
}

console.log(`Javis scheduler → ${URL} (every ${INTERVAL_MS / 1000}s, second-aligned)`);
console.log(`CRON_SECRET: ${SECRET.slice(0, 6)}…`);
console.log("Scheduled automations fire within ~1s of the set time (e.g. 3:45 → 3:45:01).");

async function warmup() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${URL}/api/cron/automations`, {
        headers: { Authorization: `Bearer ${SECRET}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok || res.status === 401) return;
    } catch {
      /* Next still booting */
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.warn("[scheduler] Next.js not ready after 30s — ticks will retry");
}

await warmup();

setTimeout(() => {
  tick();
  setInterval(tick, INTERVAL_MS);
}, msUntilNextSecond());
