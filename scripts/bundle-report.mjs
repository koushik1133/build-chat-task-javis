#!/usr/bin/env node
// Parses a `next build` log and reports the heaviest routes by First Load JS.
// Usage: node scripts/bundle-report.mjs [path-to-build-log]
import { readFileSync } from "node:fs";

const file = process.argv[2] || "build.txt";
const PUBLIC_LIMIT = 250;
const APP_LIMIT = 350;
const PUBLIC_RE = /^\/(shop|p|book|help|u|m|invite|login|offline|widget-demo)(\/|$)/;

const toKb = (n, unit) => {
  const v = parseFloat(n);
  if (unit === "MB") return v * 1024;
  if (unit === "B") return v / 1024;
  return v;
};

let text;
try {
  text = readFileSync(file, "utf8");
} catch {
  console.error(`Cannot read build log: ${file}`);
  process.exit(1);
}

const routes = [];
for (const line of text.split("\n")) {
  const m = line.match(/^[┌├└]\s+[ƒ○●λ]\s+(\S+)\s+([\d.]+)\s*(B|kB|MB)\s+([\d.]+)\s*(B|kB|MB)/);
  if (!m) continue;
  routes.push({ route: m[1], size: toKb(m[2], m[3]), first: toKb(m[4], m[5]) });
}
const pages = routes.filter((r) => !r.route.startsWith("/api/"));
pages.sort((a, b) => b.first - a.first);

const fmt = (n) => `${n.toFixed(1)} kB`;
console.log(`Top 25 heaviest page routes (${pages.length} pages, ${routes.length - pages.length} api routes)\n`);
for (const r of pages.slice(0, 25)) {
  console.log(`${r.route.padEnd(48)} page ${fmt(r.size).padStart(10)}   first-load ${fmt(r.first).padStart(10)}`);
}

const flagged = pages.filter((r) => r.first > (PUBLIC_RE.test(r.route) ? PUBLIC_LIMIT : APP_LIMIT));
console.log(`\nOver budget (public > ${PUBLIC_LIMIT} kB, app > ${APP_LIMIT} kB): ${flagged.length}`);
for (const r of flagged) {
  const pub = PUBLIC_RE.test(r.route);
  console.log(`  ${pub ? "[public]" : "[app]   "} ${r.route}  ${fmt(r.first)}  (page-specific ${fmt(r.size)})`);
}

const heavyOwn = pages.filter((r) => r.size > 20).slice(0, 10);
if (heavyOwn.length) {
  console.log("\nCandidates (large page-specific chunk; consider next/dynamic for dialogs, drawers, charts, markdown):");
  for (const r of heavyOwn) console.log(`  ${r.route}  ${fmt(r.size)}`);
}
process.exit(0);
