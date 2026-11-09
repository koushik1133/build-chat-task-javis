/**
 * Environment variable catalogue + zod schema.
 *
 * The rule list lives in vars.json so scripts/check-env.mjs (plain Node, no
 * build step) and this module share one definition. Nothing here touches the
 * database; it is safe to import from any server module.
 */
import { z } from "zod";
import catalogue from "./vars.json";

export type VarGroup = "core" | "database" | "provider" | "flag" | "dev";

export interface VarSpec {
  name: string;
  group: VarGroup;
  description: string;
  required?: boolean;
  recommended?: boolean;
  secret?: boolean;
  devOnly?: boolean;
  format?: "url" | "number";
  enum?: readonly string[];
  minLength?: number;
  default?: string;
  provider?: string;
}

export interface ProviderSpec {
  id: string;
  label: string;
  vars: readonly string[];
  /** When this flag has this value the provider becomes mandatory. */
  requiredWhen?: { var: string; equals: string };
}

export const ENV_VARS: readonly VarSpec[] = catalogue.vars as VarSpec[];
export const ENV_PROVIDERS: readonly ProviderSpec[] = catalogue.providers as ProviderSpec[];
export const ENV_VAR_NAMES: readonly string[] = ENV_VARS.map((v) => v.name);

export const REQUIRED_ENV_VARS: readonly string[] = ENV_VARS.filter((v) => v.required).map((v) => v.name);

function fieldFor(spec: VarSpec): z.ZodTypeAny {
  let base: z.ZodTypeAny;
  if (spec.enum) base = z.enum(spec.enum as [string, ...string[]]);
  else if (spec.format === "url") base = z.string().url();
  else if (spec.format === "number") base = z.string().regex(/^\d+(\.\d+)?$/, "must be a number");
  else base = z.string().min(spec.required ? 1 : 0);
  if (spec.minLength) base = z.string().min(spec.minLength);
  // Empty strings are treated as unset everywhere in the app (`?.trim()`), so
  // optional vars accept "" and the rule engine in index.ts ignores them.
  return spec.required ? base : z.union([base, z.literal("")]).optional();
}

/** Zod object covering every known variable; unknown keys pass through. */
export const envSchema = z.object(Object.fromEntries(ENV_VARS.map((v) => [v.name, fieldFor(v)]))).passthrough();

export type EnvShape = z.infer<typeof envSchema>;

/** Decode a JWT payload without verifying it. Returns null for non-JWT input. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Supabase keys come in two shapes: legacy JWTs (payload.role tells you which
 * key it is) and the newer `sb_secret_…` / `sb_publishable_…` strings.
 * Returns a human-readable problem or null when the key looks like a real
 * service-role secret.
 */
export function serviceRoleKeyProblem(key: string | undefined): string | null {
  const k = key?.trim();
  if (!k) return null;
  if (k.startsWith("sb_publishable_")) return "SUPABASE_SERVICE_ROLE_KEY is a publishable key (sb_publishable_…); use the secret key from Supabase → Settings → API.";
  if (k.startsWith("sb_secret_")) return null;
  const payload = decodeJwtPayload(k);
  if (!payload) return "SUPABASE_SERVICE_ROLE_KEY is neither a JWT nor an sb_secret_ key.";
  const role = typeof payload.role === "string" ? payload.role : "(none)";
  if (role !== "service_role") return `SUPABASE_SERVICE_ROLE_KEY has JWT role "${role}" — expected "service_role". Server-side admin calls (invites, SCIM, DSR exports) will fail with 401/403.`;
  return null;
}
