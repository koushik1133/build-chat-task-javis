/**
 * validateEnv() — runtime environment audit used by /api/health?verbose=1 and
 * mirrored (in plain JS) by scripts/check-env.mjs. Keep the two in sync: the
 * rule list is documented at the top of scripts/check-env.mjs.
 */
import { ENV_PROVIDERS, ENV_VARS, envSchema, serviceRoleKeyProblem, type ProviderSpec, type VarSpec } from "./schema";

export { ENV_PROVIDERS, ENV_VARS, ENV_VAR_NAMES, REQUIRED_ENV_VARS, envSchema, serviceRoleKeyProblem, decodeJwtPayload } from "./schema";
export type { VarSpec, ProviderSpec, VarGroup } from "./schema";

export interface ProviderStatus {
  name: string;
  label: string;
  configured: boolean;
  /** Set when some but not all variables are present. */
  partial?: string[];
  /** True when the active flag makes this provider mandatory. */
  required?: boolean;
}

export interface EnvReport {
  ok: boolean;
  /** Required variables that are unset (or made required by an active flag). */
  missing: string[];
  /** Variables that are set but fail their format/enum/length rule. */
  invalid: string[];
  warnings: string[];
  providers: ProviderStatus[];
  database: "aurora-dsql" | "postgres";
  strict: boolean;
}

export type EnvSource = Record<string, string | undefined>;

function val(env: EnvSource, name: string): string {
  return env[name]?.trim() ?? "";
}

function isLocalDb(env: EnvSource): boolean {
  const ep = val(env, "DSQL_ENDPOINT");
  return ep === "localhost" || ep === "127.0.0.1";
}

function checkFormat(spec: VarSpec, value: string): string | null {
  // Never echo a secret's value back, even when it fails validation.
  if (spec.enum && !spec.enum.includes(value)) return `${spec.name} must be one of ${spec.enum.join(", ")}${spec.secret ? "" : ` (got "${value}")`}`;
  if (spec.format === "url") {
    try { new URL(value); } catch { return `${spec.name} must be an absolute URL`; }
  }
  if (spec.format === "number" && !/^\d+(\.\d+)?$/.test(value)) return `${spec.name} must be a number`;
  if (spec.minLength && value.length < spec.minLength) return `${spec.name} must be at least ${spec.minLength} characters`;
  return null;
}

function providerStatus(p: ProviderSpec, env: EnvSource): ProviderStatus {
  const present = p.vars.filter((v) => val(env, v) !== "");
  const absent = p.vars.filter((v) => val(env, v) === "");
  const required = Boolean(p.requiredWhen && val(env, p.requiredWhen.var) === p.requiredWhen.equals);
  const status: ProviderStatus = { name: p.id, label: p.label, configured: absent.length === 0 };
  if (present.length > 0 && absent.length > 0) status.partial = absent;
  if (required) status.required = true;
  return status;
}

/**
 * Audit `env` (defaults to process.env).
 *
 * strict=false (default): misconfigurations that the app tolerates at runtime
 * (service-role key with the wrong role, dev-only flags, weak secrets) are
 * warnings. strict=true promotes them to `invalid`, which is what CI and
 * `scripts/check-env.mjs --strict` use.
 */
export function validateEnv(opts: { strict?: boolean; env?: EnvSource } = {}): EnvReport {
  const env = opts.env ?? process.env;
  const strict = opts.strict ?? false;
  const production = val(env, "NODE_ENV") === "production";
  const missing: string[] = [];
  const invalid: string[] = [];
  const warnings: string[] = [];
  const promote = (msg: string) => (strict ? invalid.push(msg) : warnings.push(msg));

  for (const spec of ENV_VARS) {
    const value = val(env, spec.name);
    if (value === "") {
      if (spec.required) missing.push(spec.name);
      else if (spec.recommended) warnings.push(`${spec.name} is unset — ${spec.description}`);
      continue;
    }
    const problem = checkFormat(spec, value);
    if (problem) invalid.push(problem);
    if (spec.devOnly && production) {
      const enabled = value === "1" || value === "true";
      if (enabled) promote(`${spec.name}=${spec.secret ? "<set>" : value} is a development-only switch and NODE_ENV is production`);
    }
  }

  // Database mode companions.
  const local = isLocalDb(env);
  if (local) {
    if (production) warnings.push("DSQL_ENDPOINT points at localhost while NODE_ENV=production — expected only inside Docker Compose");
  } else if (val(env, "DSQL_ENDPOINT") && !val(env, "AWS_REGION")) {
    warnings.push("AWS_REGION is unset; Aurora DSQL IAM signing defaults to us-east-1");
  }

  // Supabase service-role key sanity.
  const roleProblem = serviceRoleKeyProblem(env.SUPABASE_SERVICE_ROLE_KEY);
  if (roleProblem) promote(roleProblem);
  const anon = val(env, "NEXT_PUBLIC_SUPABASE_ANON_KEY");
  if (anon && anon === val(env, "SUPABASE_SERVICE_ROLE_KEY")) promote("SUPABASE_SERVICE_ROLE_KEY equals NEXT_PUBLIC_SUPABASE_ANON_KEY — the service role key must be the secret key");

  // Public URL hygiene.
  const appUrl = val(env, "NEXT_PUBLIC_APP_URL");
  if (appUrl && production && appUrl.startsWith("http://") && !/localhost|127\.0\.0\.1/.test(appUrl)) warnings.push("NEXT_PUBLIC_APP_URL uses http:// in production; OAuth providers and secure cookies expect https://");

  // Providers: all-or-nothing companions and flag-driven requirements.
  const providers = ENV_PROVIDERS.map((p) => providerStatus(p, env));
  for (const p of providers) {
    if (p.partial) warnings.push(`${p.label} is partially configured — missing ${p.partial.join(", ")}`);
    if (p.required && !p.configured) {
      const spec = ENV_PROVIDERS.find((x) => x.id === p.name);
      for (const v of spec?.vars ?? []) if (val(env, v) === "" && !missing.includes(v)) missing.push(v);
    }
  }

  // Cross-provider hints.
  const llm = providers.filter((p) => (p.name === "groq" || p.name === "gemini") && p.configured);
  if (llm.length === 0) warnings.push("No LLM provider configured (GROQ_API_KEY or GEMINI_API_KEY) — AI features return a configuration error");
  const email = providers.find((p) => p.name === (val(env, "EMAIL_PROVIDER") === "gmail" ? "gmail" : "resend"));
  if (!email?.configured) warnings.push("Email is simulated — outbound mail is written to Settings → Outbox only");
  if (val(env, "RATE_LIMIT_STORE") !== "db" && production) warnings.push("RATE_LIMIT_STORE=memory in production: limits are per-instance; set RATE_LIMIT_STORE=db when running more than one replica");
  if (val(env, "CREDENTIAL_ENCRYPTION_KEY") === "" && (val(env, "PAYMENTS_PROVIDER") === "stripe" || val(env, "PAYMENTS_PROVIDER") === "razorpay")) missing.push("CREDENTIAL_ENCRYPTION_KEY");

  return {
    ok: missing.length === 0 && invalid.length === 0,
    missing: Array.from(new Set(missing)),
    invalid,
    warnings,
    providers,
    database: local ? "postgres" : "aurora-dsql",
    strict,
  };
}

/** Full zod parse (throws). Useful in tests; the app itself uses validateEnv(). */
export function parseEnv(env: EnvSource = process.env) {
  return envSchema.parse(env);
}
