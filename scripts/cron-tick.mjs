#!/usr/bin/env node
/**
 * KernelHub — cron sidecar. POSTs /api/cron/agents with the Bearer CRON_SECRET
 * on an interval. No dependencies; intended for Docker Compose or any host
 * without a native scheduler (Vercel Cron / Cloud Scheduler replace it).
 *
 *   CRON_SECRET=… CRON_TARGET=http://app:3001 node scripts/cron-tick.mjs
 *
 * Env: CRON_TARGET (default NEXT_PUBLIC_APP_URL or http://localhost:3001),
 *      CRON_INTERVAL_MS (default 60000), CRON_SECRET (required), CRON_ONCE=1 to
 *      run a single tick and exit with its status (useful for smoke tests).
 */
const secret = process.env.CRON_SECRET?.trim();
if (!secret) {
  console.error("[cron-tick] CRON_SECRET is required");
  process.exit(1);
}
const target = (process.env.CRON_TARGET || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3001").replace(/\/$/, "");
const interval = Math.max(5_000, Number(process.env.CRON_INTERVAL_MS) || 60_000);
const once = process.env.CRON_ONCE === "1";
const url = `${target}/api/cron/agents`;

let running = false;
async function tick() {
  if (running) return; // never overlap ticks; the route also claims per-user locks
  running = true;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(interval - 1_000),
    });
    const body = await res.text();
    const level = res.ok ? "info" : "error";
    console[level](`[cron-tick] ${res.status} ${Date.now() - started}ms ${body.slice(0, 300)}`);
    return res.ok;
  } catch (err) {
    console.error(`[cron-tick] failed after ${Date.now() - started}ms:`, err instanceof Error ? err.message : err);
    return false;
  } finally {
    running = false;
  }
}

if (once) {
  tick().then((ok) => process.exit(ok ? 0 : 1));
} else {
  console.log(`[cron-tick] posting to ${url} every ${interval}ms`);
  tick();
  const timer = setInterval(tick, interval);
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { clearInterval(timer); process.exit(0); });
}
