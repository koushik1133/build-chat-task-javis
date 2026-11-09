#!/usr/bin/env node
/**
 * KernelHub — environment check (no dependencies, no build step).
 *
 *   node scripts/check-env.mjs                 # audit .env.local (+ process.env)
 *   node scripts/check-env.mjs --file .env.example --drift
 *   node scripts/check-env.mjs --strict        # warnings about misconfiguration become errors (CI)
 *   node scripts/check-env.mjs --json
 *
 * Mirrors src/lib/env/index.ts (validateEnv). Both read src/lib/env/vars.json.
 * Rules, in order:
 *   1. required vars must be set
 *   2. enum / url / number / minLength formats
 *   3. devOnly switches must be off when NODE_ENV=production (strict → error)
 *   4. database mode companions (localhost → plain Postgres; otherwise AWS_REGION hint)
 *   5. SUPABASE_SERVICE_ROLE_KEY JWT payload role must be service_role (strict → error)
 *   6. providers are all-or-nothing; a provider selected by a flag is mandatory
 *   7. cross-provider hints (no LLM, simulated email, memory rate limits in prod)
 *   --drift: every var in vars.json must appear in the env file and vice versa
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i === -1 ? undefined : args[i + 1]; };

const strict = flag("strict");
const drift = flag("drift");
const asJson = flag("json");
const fileArg = opt("file");
const envFile = resolve(ROOT, fileArg ?? ".env.local");
const useProcessEnv = !fileArg; // explicit --file audits the file alone (deterministic in CI)

const catalogue = JSON.parse(readFileSync(join(ROOT, "src/lib/env/vars.json"), "utf8"));

/** Parse a dotenv file. Returns { values, keys } where keys includes commented `# VAR=` lines. */
function parseDotenv(path) {
  const values = {};
  const keys = new Set();
  if (!existsSync(path)) return { values, keys, present: false };
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const commented = line.startsWith("#");
    const body = commented ? line.replace(/^#+\s*/, "") : line;
    const m = /^([A-Z][A-Z0-9_]*)\s*=(.*)$/.exec(body);
    if (!m) continue;
    keys.add(m[1]);
    if (commented) continue;
    let v = m[2].trim();
    const hash = v.search(/\s#/);
    if (hash !== -1 && !/^["']/.test(v)) v = v.slice(0, hash).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    values[m[1]] = v;
  }
  return { values, keys, present: true };
}

const parsed = parseDotenv(envFile);
const env = useProcessEnv ? { ...parsed.values, ...process.env } : { ...parsed.values };
const val = (n) => (env[n] ?? "").trim();

function decodeJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try { return JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")); } catch { return null; }
}
function serviceRoleKeyProblem(key) {
  const k = (key ?? "").trim();
  if (!k) return null;
  if (k.startsWith("sb_publishable_")) return "SUPABASE_SERVICE_ROLE_KEY is a publishable key (sb_publishable_…); use the secret key from Supabase → Settings → API.";
  if (k.startsWith("sb_secret_")) return null;
  const payload = decodeJwtPayload(k);
  if (!payload) return "SUPABASE_SERVICE_ROLE_KEY is neither a JWT nor an sb_secret_ key.";
  const role = typeof payload.role === "string" ? payload.role : "(none)";
  if (role !== "service_role") return `SUPABASE_SERVICE_ROLE_KEY has JWT role "${role}" — expected "service_role". Server-side admin calls (invites, SCIM, DSR exports) will fail with 401/403.`;
  return null;
}
function checkFormat(spec, value) {
  if (spec.enum && !spec.enum.includes(value)) return `${spec.name} must be one of ${spec.enum.join(", ")} (got "${value}")`;
  if (spec.format === "url") { try { new URL(value); } catch { return `${spec.name} must be an absolute URL`; } }
  if (spec.format === "number" && !/^\d+(\.\d+)?$/.test(value)) return `${spec.name} must be a number`;
  if (spec.minLength && value.length < spec.minLength) return `${spec.name} must be at least ${spec.minLength} characters`;
  return null;
}

const production = val("NODE_ENV") === "production";
const missing = [], invalid = [], warnings = [];
const promote = (m) => (strict ? invalid : warnings).push(m);

for (const spec of catalogue.vars) {
  const value = val(spec.name);
  if (value === "") {
    if (spec.required) missing.push(spec.name);
    else if (spec.recommended) warnings.push(`${spec.name} is unset — ${spec.description}`);
    continue;
  }
  const problem = checkFormat(spec, value);
  if (problem) invalid.push(problem);
  if (spec.devOnly && production && (value === "1" || value === "true")) promote(`${spec.name}=${value} is a development-only switch and NODE_ENV is production`);
}

const ep = val("DSQL_ENDPOINT");
const local = ep === "localhost" || ep === "127.0.0.1";
if (local) { if (production) warnings.push("DSQL_ENDPOINT points at localhost while NODE_ENV=production — expected only inside Docker Compose"); }
else if (ep && !val("AWS_REGION")) warnings.push("AWS_REGION is unset; Aurora DSQL IAM signing defaults to us-east-1");

const roleProblem = serviceRoleKeyProblem(env.SUPABASE_SERVICE_ROLE_KEY);
if (roleProblem) promote(roleProblem);
if (val("NEXT_PUBLIC_SUPABASE_ANON_KEY") && val("NEXT_PUBLIC_SUPABASE_ANON_KEY") === val("SUPABASE_SERVICE_ROLE_KEY")) promote("SUPABASE_SERVICE_ROLE_KEY equals NEXT_PUBLIC_SUPABASE_ANON_KEY — the service role key must be the secret key");
const appUrl = val("NEXT_PUBLIC_APP_URL");
if (appUrl && production && appUrl.startsWith("http://") && !/localhost|127\.0\.0\.1/.test(appUrl)) warnings.push("NEXT_PUBLIC_APP_URL uses http:// in production; OAuth providers and secure cookies expect https://");

const providers = catalogue.providers.map((p) => {
  const absent = p.vars.filter((v) => val(v) === "");
  const present = p.vars.length - absent.length;
  const required = Boolean(p.requiredWhen && val(p.requiredWhen.var) === p.requiredWhen.equals);
  const s = { name: p.id, label: p.label, configured: absent.length === 0 };
  if (present > 0 && absent.length > 0) s.partial = absent;
  if (required) s.required = true;
  if (s.partial) warnings.push(`${p.label} is partially configured — missing ${absent.join(", ")}`);
  if (required && !s.configured) for (const v of absent) if (!missing.includes(v)) missing.push(v);
  return s;
});

if (!providers.some((p) => (p.name === "groq" || p.name === "gemini") && p.configured)) warnings.push("No LLM provider configured (GROQ_API_KEY or GEMINI_API_KEY) — AI features return a configuration error");
const emailId = val("EMAIL_PROVIDER") === "gmail" ? "gmail" : "resend";
if (!providers.find((p) => p.name === emailId)?.configured) warnings.push("Email is simulated — outbound mail is written to Settings → Outbox only");
if (val("RATE_LIMIT_STORE") !== "db" && production) warnings.push("RATE_LIMIT_STORE=memory in production: limits are per-instance; set RATE_LIMIT_STORE=db when running more than one replica");
if (val("CREDENTIAL_ENCRYPTION_KEY") === "" && ["stripe", "razorpay"].includes(val("PAYMENTS_PROVIDER"))) missing.push("CREDENTIAL_ENCRYPTION_KEY");

// ── drift: vars.json ↔ env file ───────────────────────────────────────────────
const driftErrors = [];
if (drift) {
  const known = new Set(catalogue.vars.map((v) => v.name));
  for (const name of known) if (!parsed.keys.has(name)) driftErrors.push(`${name} is in vars.json but not in ${fileArg ?? ".env.local"}`);
  for (const name of parsed.keys) if (!known.has(name)) driftErrors.push(`${name} is in ${fileArg ?? ".env.local"} but not in src/lib/env/vars.json`);
}

const report = {
  file: envFile,
  filePresent: parsed.present,
  strict,
  database: local ? "postgres" : "aurora-dsql",
  ok: missing.length === 0 && invalid.length === 0 && driftErrors.length === 0,
  missing: [...new Set(missing)],
  invalid,
  warnings,
  drift: driftErrors,
  providers,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`KernelHub env check — ${fileArg ?? ".env.local"}${useProcessEnv ? " + process.env" : ""} (${report.database})${strict ? " [strict]" : ""}\n`);
  if (!parsed.present) console.log(`  (env file ${envFile} not found; using process.env only)\n`);
  const section = (title, items, mark) => { if (items.length) { console.log(`${title}:`); for (const i of items) console.log(`  ${mark} ${i}`); console.log(); } };
  section("Missing required", report.missing, "✗");
  section("Invalid", report.invalid, "✗");
  section("Drift", report.drift, "✗");
  section("Warnings", report.warnings, "!");
  console.log("Providers:");
  for (const p of providers) console.log(`  ${p.configured ? "●" : "○"} ${p.label}${p.partial ? ` (missing ${p.partial.join(", ")})` : ""}${p.required ? " [required by flag]" : ""}`);
  console.log(`\n${report.ok ? "OK" : "FAILED"}`);
}
process.exit(report.ok ? 0 : 1);
