import OpenAI from "openai";

// Groq only — uses the OpenAI-compatible REST API.
// Required env var: GROQ_API_KEY
// Optional: GROQ_MODEL (default: llama-3.3-70b-versatile)

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export const MODEL = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";

function client() {
  const key = process.env.GROQ_API_KEY;
  if (!key) {
    throw new Error(
      "GROQ_API_KEY is not set. Add it in Vercel → Settings → Environment Variables."
    );
  }
  return new OpenAI({
    apiKey: key,
    baseURL: "https://api.groq.com/openai/v1",
  });
}

export async function streamChat(messages: ChatMessage[]) {
  return client().chat.completions.create({
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

export async function complete(
  messages: ChatMessage[],
  { retries = 3, maxTokens = 1024 }: { retries?: number; maxTokens?: number } = {}
): Promise<string> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await client().chat.completions.create({
        model: MODEL,
        messages,
        temperature: 0.4,
        max_tokens: maxTokens,
      });
      return res.choices[0]?.message?.content ?? "";
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 429 && attempt < retries) {
        // Back off: 15s, 30s, 60s
        await new Promise((r) => setTimeout(r, 15_000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  return "";
}
