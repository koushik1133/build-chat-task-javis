import OpenAI from "openai";
import { completeWithTools, isRetriableLlmError } from "@/lib/llm/router";
import { availableProviders } from "@/lib/llm/providers";

// Simple facade for plain completions. Failover (Groq → Gemini on network
// errors, 5xx, timeouts and persistent 429s) lives in src/lib/llm/router.ts.
// Required env var: GROQ_API_KEY and/or GEMINI_API_KEY
// Optional: GROQ_MODEL (default: llama-3.3-70b-versatile), GEMINI_MODEL

export { LlmNotConfiguredError, isLlmConfigured } from "@/lib/llm/providers";
import { LlmNotConfiguredError } from "@/lib/llm/providers";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

/**
 * Streaming chat. Uses the first available provider; if opening the stream
 * fails with a retriable error the next provider is tried.
 */
export async function streamChat(messages: ChatMessage[]) {
  const providers = availableProviders();
  if (providers.length === 0) throw new LlmNotConfiguredError();

  let lastError: unknown;
  for (const p of providers) {
    const openai = new OpenAI({ apiKey: p.apiKey, baseURL: p.baseURL, maxRetries: 0 });
    try {
      return await openai.chat.completions.create({
        model: p.model,
        messages,
        stream: true,
        temperature: 0.4,
      });
    } catch (err) {
      lastError = err;
      if (!isRetriableLlmError(err)) throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("All LLM providers failed");
}

export async function completeJson<T>(
  messages: ChatMessage[],
  schemaHint: string
): Promise<T | null> {
  const res = await completeWithTools(
    [
      ...messages,
      {
        role: "system",
        content: `Reply with ONLY valid JSON matching: ${schemaHint}. No prose, no code fences.`,
      },
    ],
    { temperature: 0, maxTokens: 1500 }
  );
  const raw = res.content?.trim() ?? "";
  const cleaned = raw.replace(/^```(?:json)?\s*|```\s*$/g, "");
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

export async function complete(
  messages: ChatMessage[],
  { retries = 3, maxTokens = 1024 }: { retries?: number; maxTokens?: number } = {}
): Promise<string> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await completeWithTools(messages, { maxTokens, temperature: 0.4 });
      return res.content ?? "";
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      // Every provider was rate limited: back off 15s, 30s, 60s and try again.
      if (status === 429 && attempt < retries) {
        await new Promise((r) => setTimeout(r, 15_000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  return "";
}
