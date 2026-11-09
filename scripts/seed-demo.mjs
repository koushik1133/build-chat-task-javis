#!/usr/bin/env node
/**
 * Load or clear the KernelHub sample workspace through the local API.
 *
 *   KH_API_KEY=kh_... node scripts/seed-demo.mjs [--industry agency] [--currency USD] [--clear] [--base http://localhost:3001]
 *
 * The API key needs the `write:settings` scope (Settings → API keys). No
 * extra dependencies: this is a thin wrapper over POST /api/demo/seed and
 * DELETE /api/demo/clear, which call src/lib/demo/seed.ts.
 */

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const clear = args.includes("--clear");
const base = (flag("base") || process.env.KH_BASE_URL || "http://localhost:3001").replace(/\/$/, "");
const key = process.env.KH_API_KEY;

if (!key) {
  console.error("KH_API_KEY is required (create one under Settings → API keys with the write:settings scope).");
  process.exit(2);
}

const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };

async function main() {
  const url = clear ? `${base}/api/demo/clear` : `${base}/api/demo/seed`;
  const body = clear ? undefined : JSON.stringify({ industry: flag("industry"), currency: flag("currency") });
  const res = await fetch(url, { method: clear ? "DELETE" : "POST", headers, body, signal: AbortSignal.timeout(120_000) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    console.error(`${res.status} ${res.statusText}:`, json);
    process.exit(1);
  }
  console.log(JSON.stringify(json, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
