import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { ENV_PROVIDERS, ENV_VARS, ENV_VAR_NAMES, REQUIRED_ENV_VARS, decodeJwtPayload, serviceRoleKeyProblem, validateEnv } from "@/lib/env";

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.sig`;
}

const GOOD: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: "https://proj.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: jwt({ role: "anon" }),
  SUPABASE_SERVICE_ROLE_KEY: jwt({ role: "service_role" }),
  DSQL_ENDPOINT: "127.0.0.1",
  CRON_SECRET: "0123456789abcdef0123456789abcdef",
  NEXT_PUBLIC_APP_URL: "http://localhost:3001",
  GROQ_API_KEY: "gsk_x",
  RESEND_API_KEY: "re_x",
  RESEND_FROM: "KernelHub <ai@example.com>",
};

describe("validateEnv", () => {
  it("passes a complete local configuration", () => {
    const r = validateEnv({ env: GOOD });
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.invalid).toEqual([]);
    expect(r.database).toBe("postgres");
    expect(r.providers.find((p) => p.name === "groq")?.configured).toBe(true);
  });

  it("reports every missing required var", () => {
    const r = validateEnv({ env: {} });
    expect(r.ok).toBe(false);
    for (const name of REQUIRED_ENV_VARS) expect(r.missing).toContain(name);
    expect(r.missing).toContain("CRON_SECRET");
  });

  it("treats empty strings as unset", () => {
    const r = validateEnv({ env: { ...GOOD, CRON_SECRET: "   " } });
    expect(r.missing).toEqual(["CRON_SECRET"]);
  });

  it("flags enum, url and length violations as invalid", () => {
    const r = validateEnv({ env: { ...GOOD, PAYMENTS_PROVIDER: "paypal", NEXT_PUBLIC_APP_URL: "not a url", CRON_SECRET: "short" } });
    expect(r.ok).toBe(false);
    expect(r.invalid.some((m) => m.startsWith("PAYMENTS_PROVIDER must be one of"))).toBe(true);
    expect(r.invalid.some((m) => m.startsWith("NEXT_PUBLIC_APP_URL must be an absolute URL"))).toBe(true);
    expect(r.invalid.some((m) => m.startsWith("CRON_SECRET must be at least 16"))).toBe(true);
  });

  it("requires the whole TWILIO_* trio once one is set", () => {
    const r = validateEnv({ env: { ...GOOD, TWILIO_ACCOUNT_SID: "AC1" } });
    const twilio = r.providers.find((p) => p.name === "twilio");
    expect(twilio?.configured).toBe(false);
    expect(twilio?.partial).toEqual(["TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"]);
    expect(r.warnings.some((w) => w.includes("Twilio") && w.includes("TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER"))).toBe(true);
    // partial providers are warnings, not hard failures
    expect(r.ok).toBe(true);
    const full = validateEnv({ env: { ...GOOD, TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_FROM_NUMBER: "+15550000000" } });
    expect(full.providers.find((p) => p.name === "twilio")?.configured).toBe(true);
  });

  it("makes a provider mandatory when its flag selects it", () => {
    const r = validateEnv({ env: { ...GOOD, PAYMENTS_PROVIDER: "stripe" } });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(expect.arrayContaining(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "CREDENTIAL_ENCRYPTION_KEY"]));
    expect(r.providers.find((p) => p.name === "stripe")?.required).toBe(true);
    const ok = validateEnv({ env: { ...GOOD, PAYMENTS_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk", STRIPE_WEBHOOK_SECRET: "wh", CREDENTIAL_ENCRYPTION_KEY: "k" } });
    expect(ok.missing).toEqual([]);
  });

  it("warns when the service-role key JWT role is not service_role, and fails in strict mode", () => {
    const env = { ...GOOD, SUPABASE_SERVICE_ROLE_KEY: jwt({ role: "anon" }) };
    const lax = validateEnv({ env });
    expect(lax.ok).toBe(true);
    expect(lax.warnings.some((w) => w.includes('JWT role "anon"'))).toBe(true);
    const strict = validateEnv({ env, strict: true });
    expect(strict.ok).toBe(false);
    expect(strict.invalid.some((w) => w.includes('JWT role "anon"'))).toBe(true);
  });

  it("accepts sb_secret_ keys and rejects sb_publishable_ keys", () => {
    expect(serviceRoleKeyProblem("sb_secret_abc")).toBeNull();
    expect(serviceRoleKeyProblem("sb_publishable_abc")).toMatch(/publishable/);
    expect(serviceRoleKeyProblem(jwt({ role: "service_role" }))).toBeNull();
    expect(serviceRoleKeyProblem("garbage")).toMatch(/neither/);
    expect(serviceRoleKeyProblem(undefined)).toBeNull();
    expect(decodeJwtPayload("a.b")).toBeNull();
  });

  it("flags dev-only switches in production", () => {
    const r = validateEnv({ env: { ...GOOD, NODE_ENV: "production", WEBHOOKS_ALLOW_INSECURE: "1" }, strict: true });
    expect(r.invalid.some((m) => m.startsWith("WEBHOOKS_ALLOW_INSECURE=1"))).toBe(true);
  });

  it("warns when no LLM provider is configured", () => {
    const { GROQ_API_KEY: _drop, ...rest } = GOOD;
    void _drop;
    const r = validateEnv({ env: rest });
    expect(r.warnings.some((w) => w.startsWith("No LLM provider"))).toBe(true);
  });
});

describe("vars.json catalogue", () => {
  it("has unique names and every provider var exists", () => {
    expect(new Set(ENV_VAR_NAMES).size).toBe(ENV_VAR_NAMES.length);
    for (const p of ENV_PROVIDERS) for (const v of p.vars) expect(ENV_VAR_NAMES, `${p.id} → ${v}`).toContain(v);
    for (const p of ENV_PROVIDERS) if (p.requiredWhen) expect(ENV_VAR_NAMES).toContain(p.requiredWhen.var);
    for (const v of ENV_VARS) expect(v.description.length, v.name).toBeGreaterThan(5);
  });

  it("stays in sync with .env.example (no drift either way)", () => {
    const example = readFileSync(join(process.cwd(), ".env.example"), "utf8");
    const inExample = new Set<string>();
    for (const raw of example.split("\n")) {
      const m = /^#?\s*([A-Z][A-Z0-9_]*)\s*=/.exec(raw.trim());
      if (m) inExample.add(m[1]);
    }
    const known = new Set(ENV_VAR_NAMES);
    const missingFromExample = [...known].filter((n) => !inExample.has(n));
    const unknownInExample = [...inExample].filter((n) => !known.has(n));
    expect(missingFromExample, "add these to .env.example").toEqual([]);
    expect(unknownInExample, "add these to src/lib/env/vars.json").toEqual([]);
  });

  it("covers every process.env.X referenced in src/ (excluding runtime vars)", () => {
    const out = execSync(`grep -rhoE "process\\.env\\.[A-Z][A-Z0-9_]+" src --include='*.ts' --include='*.tsx' | sort -u`, { cwd: process.cwd(), encoding: "utf8" });
    // Runtime/platform vars plus KH_WEBHOOK_SECRET, which only appears inside a
    // customer-facing code sample on Settings → Developers (never read by the app).
    const RUNTIME = new Set(["NODE_ENV", "PORT", "NEXT_OUTPUT", "DB_INTEGRATION", "VERCEL", "VERCEL_URL", "CI", "KH_WEBHOOK_SECRET"]);
    const referenced = out.split("\n").filter(Boolean).map((l) => l.replace("process.env.", "")).filter((n) => !RUNTIME.has(n));
    const known = new Set(ENV_VAR_NAMES);
    expect(referenced.filter((n) => !known.has(n)), "add these to src/lib/env/vars.json").toEqual([]);
  });
});
