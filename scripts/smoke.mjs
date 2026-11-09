#!/usr/bin/env node
/**
 * KernelHub — post-deploy smoke test. No dependencies.
 *
 *   node scripts/smoke.mjs                       # against http://localhost:3001
 *   node scripts/smoke.mjs https://app.example.com
 *   KH_BASE_URL=… npm run smoke
 *
 * Checks: /api/health (200 + ok:true), /login (200 HTML), /manifest.webmanifest
 * (200 JSON), /api/v1/openapi.json (200 with openapi field), an authenticated
 * route without credentials (401), and /api/cron/agents without a token (401).
 * Exits non-zero when any check fails.
 */
const base = (process.argv[2] || process.env.KH_BASE_URL || "http://localhost:3001").replace(/\/$/, "");
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS) || 15_000;

const checks = [
  { path: "/api/health", status: 200, json: (b) => b && b.ok === true && b.database === "connected", label: "health reports ok + database connected" },
  { path: "/login", status: 200, text: (t) => /<html/i.test(t), label: "login page renders" },
  { path: "/manifest.webmanifest", status: 200, json: (b) => typeof b?.name === "string", label: "PWA manifest" },
  { path: "/api/v1/openapi.json", status: 200, json: (b) => typeof b?.openapi === "string", label: "OpenAPI document" },
  { path: "/api/ready", status: 200, json: (b) => b && b.ready === true, label: "readiness (database + critical tables)" },
  { path: "/api/metrics", status: [404, 401], label: "metrics endpoint is closed without a token" },
  { path: "/api/v1/me", status: 401, label: "API v1 rejects anonymous callers" },
  { path: "/api/cron/agents", status: 401, label: "cron route rejects missing bearer" },
];

let failed = 0;
for (const c of checks) {
  const url = base + c.path;
  const started = Date.now();
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json, text/html" } });
    const text = await res.text();
    let ok = Array.isArray(c.status) ? c.status.includes(res.status) : res.status === c.status;
    let detail = `${res.status}`;
    if (ok && c.json) {
      let body = null;
      try { body = JSON.parse(text); } catch { /* not JSON */ }
      ok = Boolean(c.json(body));
      if (!ok) detail += ` body=${text.slice(0, 120)}`;
    }
    if (ok && c.text) { ok = c.text(text); if (!ok) detail += " unexpected body"; }
    console.log(`${ok ? "PASS" : "FAIL"} ${c.path.padEnd(24)} ${detail.padEnd(6)} ${Date.now() - started}ms  ${c.label}`);
    if (!ok) failed++;
  } catch (err) {
    failed++;
    console.log(`FAIL ${c.path.padEnd(24)} error  ${Date.now() - started}ms  ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed against ${base}`);
process.exit(failed === 0 ? 0 : 1);
