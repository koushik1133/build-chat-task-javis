import OpenAI from "openai";
import { LlmNotConfiguredError } from "@/lib/llm";
import type { LlmTurnResult, RouterMessage, ToolSpec } from "@/lib/agents/types";
import { toOpenAiTools, fromOpenAiToolName } from "@/lib/agents/registry";

/**
 * Provider-aware LLM router with tool calling and failover.
 *
 * Providers are tried in order; a network error, 5xx, timeout, or 429 that
 * survives a short backoff moves to the next provider. Which provider actually
 * served the request is returned so usage can be attributed and metered.
 *
 * `src/lib/llm.ts` remains the simple facade for plain completions; this
 * module is what the agent loop and copilots use.
 */

export interface ProviderDef {
  id: "groq" | "gemini";
  apiKey: string;
  baseURL: string;
  model: string;
}

export function availableProviders(): ProviderDef[] {
  const out: ProviderDef[] = [];
  const groq = process.env.GROQ_API_KEY?.trim();
  const gemini = process.env.GEMINI_API_KEY?.trim();
  if (groq) {
    out.push({
      id: "groq",
      apiKey: groq,
      baseURL: "https://api.groq.com/openai/v1",
      model: process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile",
    });
  }
  if (gemini) {
    out.push({
      id: "gemini",
      apiKey: gemini,
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
      model: process.env.GEMINI_MODEL ?? "gemini-1.5-flash",
    });
  }
  return out;
}

export interface CompleteWithToolsOptions {
  tools?: ToolSpec[];
  /** Force a specific provider/model (e.g. from an agent's `model` column or allowlist). */
  model?: string | null;
  allowlist?: string[] | null;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

function isRetriable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 429 || (typeof status === "number" && status >= 500)) return true;
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  return /timeout|timed out|econnreset|econnrefused|fetch failed|network|aborted/.test(msg);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * One model turn. Returns text and/or tool calls; the caller runs the tools
 * and calls again with `tool` messages appended.
 */
export async function completeWithTools(
  messages: RouterMessage[],
  opts: CompleteWithToolsOptions = {}
): Promise<LlmTurnResult> {
  let providers = availableProviders();
  if (opts.allowlist && opts.allowlist.length > 0) {
    const allow = new Set(opts.allowlist);
    providers = providers.filter((p) => allow.has(p.id) || allow.has(p.model));
  }
  if (providers.length === 0) throw new LlmNotConfiguredError();

  const tools = opts.tools && opts.tools.length > 0 ? toOpenAiTools(opts.tools) : undefined;
  const timeoutMs = opts.timeoutMs ?? 25_000;
  let lastError: unknown;

  for (const p of providers) {
    const client = new OpenAI({ apiKey: p.apiKey, baseURL: p.baseURL, timeout: timeoutMs, maxRetries: 0 });
    const model = opts.model && opts.model.trim() ? opts.model : p.model;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await client.chat.completions.create({
          model,
          messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
          max_tokens: opts.maxTokens ?? 1500,
          temperature: opts.temperature ?? 0.3,
          ...(tools ? { tools, tool_choice: "auto" as const } : {}),
        });

        const choice = res.choices[0];
        return {
          content: choice?.message?.content ?? null,
          toolCalls: (choice?.message?.tool_calls ?? [])
            .filter((c) => c.type === "function")
            .map((c) => ({
              id: c.id,
              name: fromOpenAiToolName(c.function.name),
              arguments: c.function.arguments ?? "{}",
            })),
          provider: p.id,
          model,
          promptTokens: res.usage?.prompt_tokens ?? 0,
          completionTokens: res.usage?.completion_tokens ?? 0,
          finishReason: choice?.finish_reason ?? null,
        };
      } catch (err) {
        lastError = err;
        if (!isRetriable(err)) throw err;
        // One short backoff on the same provider (rate limits are usually brief).
        if (attempt === 0 && (err as { status?: number })?.status === 429) {
          await sleep(1500);
          continue;
        }
        break; // fail over to the next provider
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("All LLM providers failed");
}
