#!/usr/bin/env node
/**
 * Aurora DSQL compatibility lint (no dependencies).
 *   node scripts/dsql-lint.mjs            # migrations + src
 *   node scripts/dsql-lint.mjs --no-src   # migrations only
 * Exits 1 when any non-allow-listed error remains. Rules: src/lib/dsql-compat/rules.ts
 * (loaded via Node's TypeScript type-stripping, falling back to a transpile of the file).
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const rulesPath = join(ROOT, "src/lib/dsql-compat/rules.ts");

async function loadRules() {
  try {
    return await import(rulesPath);
  } catch {
    const ts = await import("typescript");
    const out = ts.default.transpileModule(readFileSync(rulesPath, "utf8"), { compilerOptions: { module: ts.default.ModuleKind.ESNext, target: ts.default.ScriptTarget.ES2022 } });
    return await import("data:text/javascript;base64," + Buffer.from(out.outputText).toString("base64"));
  }
}
const { lintDdl, lintSource, applyAllowList, formatFinding } = await loadRules();

function walk(dir, pred, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { if (!["node_modules", ".next", "__tests__", "__integration__"].includes(name)) walk(p, pred, acc); }
    else if (pred(p)) acc.push(p);
  }
  return acc;
}

const sqlFiles = [join(ROOT, "aws/migrations.sql"), ...readdirSync(join(ROOT, "aws")).filter((d) => /^phase\d+$/.test(d)).sort().flatMap((d) => readdirSync(join(ROOT, "aws", d)).filter((f) => f.endsWith(".sql")).sort().map((f) => join(ROOT, "aws", d, f)))];
const srcFiles = process.argv.includes("--no-src") ? [] : walk(join(ROOT, "src"), (p) => /\.(ts|tsx)$/.test(p) && !/\.test\./.test(p) && !p.includes("dsql-compat/rules.ts"));

const findings = [];
for (const f of sqlFiles) findings.push(...lintDdl(relative(ROOT, f), readFileSync(f, "utf8")));
for (const f of srcFiles) findings.push(...lintSource(relative(ROOT, f), readFileSync(f, "utf8")));

const allowPath = join(ROOT, "scripts/dsql-lint.allow.json");
const allow = existsSync(allowPath) ? JSON.parse(readFileSync(allowPath, "utf8")) : [];
const { reported, allowed, badEntries } = applyAllowList(findings, allow);

for (const f of reported) console.log(formatFinding(f) + "\n");
for (const a of badEntries) console.log(`ERROR   allow-list entry without a reason: ${JSON.stringify(a)}`);
const errors = reported.filter((f) => f.severity === "error").length + badEntries.length;
const warnings = reported.filter((f) => f.severity === "warning").length;
console.log(`dsql-lint: ${sqlFiles.length} SQL files, ${srcFiles.length} source files — ${errors} error(s), ${warnings} warning(s), ${allowed.length} allow-listed`);
process.exit(errors > 0 ? 1 : 0);
