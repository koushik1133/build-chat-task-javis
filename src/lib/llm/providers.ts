/**
 * Model provider catalogue.
 *
 * Both providers speak the OpenAI-compatible chat API, so the router only
 * needs a base URL, a key and a default model per provider. Order matters:
 * providers are tried in the order returned by `availableProviders()`.
 */

export type ProviderId = "groq" | "gemini";

export interface ProviderDef {
  id: ProviderId;
  apiKey: string;
  baseURL: string;
  model: string;
  /** Whether the provider accepts OpenAI-style `tools` / `tool_calls`. */
  supportsTools: boolean;
}

/** Public, key-free description for the settings page. */
export interface ProviderInfo {
  id: ProviderId;
  label: string;
  model: string;
  envKey: string;
  configured: boolean;
  supportsTools: boolean;
}

interface CatalogEntry {
  id: ProviderId;
  label: string;
  envKey: string;
  modelEnv: string;
  defaultModel: string;
  baseURL: string;
  supportsTools: boolean;
}

const CATALOG: CatalogEntry[] = [
  {
    id: "groq",
    label: "Groq",
    envKey: "GROQ_API_KEY",
    modelEnv: "GROQ_MODEL",
    defaultModel: "llama-3.3-70b-versatile",
    baseURL: "https://api.groq.com/openai/v1",
    supportsTools: true,
  },
  {
    id: "gemini",
    label: "Google Gemini",
    envKey: "GEMINI_API_KEY",
    modelEnv: "GEMINI_MODEL",
    defaultModel: "gemini-1.5-flash",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    supportsTools: true,
  },
];

/**
 * Raised when no model provider is configured. Distinct from a genuine upstream
 * failure so routes can answer 503 with an actionable message instead of a
 * generic 500 that looks like a bug in the app.
 */
export class LlmNotConfiguredError extends Error {
  constructor() {
    super(
      "AI features are not configured. Set GROQ_API_KEY or GEMINI_API_KEY in your environment."
    );
    this.name = "LlmNotConfiguredError";
  }
}

function keyFor(entry: CatalogEntry): string {
  return process.env[entry.envKey]?.trim() ?? "";
}

function modelFor(entry: CatalogEntry): string {
  return process.env[entry.modelEnv]?.trim() || entry.defaultModel;
}

/** True when at least one model provider key is present. */
export function isLlmConfigured(): boolean {
  return CATALOG.some((e) => keyFor(e).length > 0);
}

/** Configured providers, in failover order. */
export function availableProviders(): ProviderDef[] {
  const out: ProviderDef[] = [];
  for (const e of CATALOG) {
    const apiKey = keyFor(e);
    if (!apiKey) continue;
    out.push({ id: e.id, apiKey, baseURL: e.baseURL, model: modelFor(e), supportsTools: e.supportsTools });
  }
  return out;
}

/** Every known provider (configured or not), without secrets. */
export function describeProviders(): ProviderInfo[] {
  return CATALOG.map((e) => ({
    id: e.id,
    label: e.label,
    model: modelFor(e),
    envKey: e.envKey,
    configured: keyFor(e).length > 0,
    supportsTools: e.supportsTools,
  }));
}
