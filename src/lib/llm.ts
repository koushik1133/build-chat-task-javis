import OpenAI from "openai";

// Groq only — uses the OpenAI-compatible REST API.
// Required env var: GROQ_API_KEY
// Optional: GROQ_MODEL (default: llama-3.3-70b-versatile)

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

function client() {
  const groqKey = process.env.GROQ_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!groqKey && !geminiKey) {
    throw new Error(
      "Neither GROQ_API_KEY nor GEMINI_API_KEY is set. Add one to Vercel → Settings → Environment Variables."
    );
  }

  if (groqKey) {
    return {
      openai: new OpenAI({
        apiKey: groqKey,
        baseURL: "https://api.groq.com/openai/v1",
      }),
      model: process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile",
    };
  }

  // Fallback to Gemini
  return {
    openai: new OpenAI({
      apiKey: geminiKey!,
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    }),
    model: process.env.GEMINI_MODEL ?? "gemini-1.5-flash",
  };
}

export async function streamChat(messages: ChatMessage[]) {
  const { openai, model } = client();
  return openai.chat.completions.create({
    model,
    messages,
    stream: true,
    temperature: 0.4,
  });
}

export async function completeJson<T>(
  messages: ChatMessage[],
  schemaHint: string
): Promise<T | null> {
  const { openai, model } = client();
  const res = await openai.chat.completions.create({
    model,
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
      const { openai, model } = client();
      const res = await openai.chat.completions.create({
        model,
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
