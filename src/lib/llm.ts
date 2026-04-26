import OpenAI from "openai";

// Provider abstraction. Resume claims Claude; we currently run on Grok (xAI)
// via the OpenAI-compatible SDK. Swap LLM_PROVIDER=anthropic to switch later.

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

const provider = (process.env.LLM_PROVIDER ?? "groq").toLowerCase();

function client() {
  if (provider === "groq") {
    return new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
    });
  }
  if (provider === "grok") {
    return new OpenAI({
      apiKey: process.env.XAI_API_KEY,
      baseURL: "https://api.x.ai/v1",
    });
  }
  // Future Claude-compat: drop in @anthropic-ai/sdk here without changing callers.
  throw new Error(`LLM_PROVIDER=${provider} not yet wired`);
}

export const MODEL =
  provider === "groq"
    ? process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile"
    : provider === "grok"
      ? process.env.XAI_MODEL ?? "grok-2-latest"
      : "claude-sonnet-4-6";

export async function streamChat(messages: ChatMessage[]) {
  const c = client();
  return c.chat.completions.create({
    model: MODEL,
    messages,
    stream: true,
    temperature: 0.4,
  });
}

export async function completeJson<T>(
  messages: ChatMessage[],
  schemaHint: string
): Promise<T | null> {
  const c = client();
  const res = await c.chat.completions.create({
    model: MODEL,
    messages: [
      ...messages,
      {
        role: "system",
        content: `Reply with ONLY valid JSON matching: ${schemaHint}. No prose, no code fences.`,
      },
    ],
    temperature: 0,
  });
  const raw = res.choices[0]?.message?.content?.trim() ?? "";
  const cleaned = raw.replace(/^```(?:json)?\s*|```\s*$/g, "");
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

export async function complete(messages: ChatMessage[]) {
  const c = client();
  const res = await c.chat.completions.create({
    model: MODEL,
    messages,
    temperature: 0.4,
  });
  return res.choices[0]?.message?.content ?? "";
}
