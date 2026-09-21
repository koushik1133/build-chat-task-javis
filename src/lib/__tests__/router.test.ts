import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
vi.mock("openai", () => ({
  default: class OpenAI {
    chat = { completions: { create: (...args: unknown[]) => create(...args) } };
  },
}));

vi.mock("@/lib/agents/registry", () => ({
  toOpenAiTools: () => [],
  fromOpenAiToolName: (n: string) => n.replace("__", "."),
}));

import { availableProviders, completeWithTools } from "@/lib/llm/router";
import { LlmNotConfiguredError } from "@/lib/llm/providers";

function httpError(status: number, message = `HTTP ${status}`) {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

const ok = (content: string) => ({
  choices: [{ message: { content, tool_calls: [] }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});

describe("completeWithTools", () => {
  const env = { ...process.env };
  beforeEach(() => {
    create.mockReset();
    process.env.GROQ_API_KEY = "groq-key";
    process.env.GEMINI_API_KEY = "gemini-key";
    delete process.env.GROQ_MODEL;
    delete process.env.GEMINI_MODEL;
  });
  afterEach(() => {
    process.env = { ...env };
  });

  it("lists providers in failover order", () => {
    expect(availableProviders().map((p) => p.id)).toEqual(["groq", "gemini"]);
    delete process.env.GROQ_API_KEY;
    expect(availableProviders().map((p) => p.id)).toEqual(["gemini"]);
  });

  it("throws LlmNotConfiguredError when no provider is configured", async () => {
    delete process.env.GROQ_API_KEY;
    delete process.env.GEMINI_API_KEY;
    await expect(completeWithTools([{ role: "user", content: "hi" }])).rejects.toBeInstanceOf(LlmNotConfiguredError);
    expect(create).not.toHaveBeenCalled();
  });

  it("fails over to the second provider when the first returns 503", async () => {
    create.mockRejectedValueOnce(httpError(503)).mockResolvedValueOnce(ok("from gemini"));
    const res = await completeWithTools([{ role: "user", content: "hi" }]);
    expect(res.content).toBe("from gemini");
    expect(res.provider).toBe("gemini");
    expect(res.model).toBe("gemini-1.5-flash");
    expect(res.promptTokens).toBe(10);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("fails over on network errors", async () => {
    create.mockRejectedValueOnce(new Error("fetch failed")).mockResolvedValueOnce(ok("ok"));
    const res = await completeWithTools([{ role: "user", content: "hi" }]);
    expect(res.provider).toBe("gemini");
  });

  it("propagates non-retriable errors without failing over", async () => {
    create.mockRejectedValueOnce(httpError(400, "bad request"));
    await expect(completeWithTools([{ role: "user", content: "hi" }])).rejects.toThrow("bad request");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("rethrows the last error when every provider fails", async () => {
    create.mockRejectedValueOnce(httpError(500)).mockRejectedValueOnce(httpError(502, "gemini down"));
    await expect(completeWithTools([{ role: "user", content: "hi" }])).rejects.toThrow("gemini down");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("honours the allowlist", async () => {
    create.mockResolvedValueOnce(ok("ok"));
    const res = await completeWithTools([{ role: "user", content: "hi" }], { allowlist: ["gemini"] });
    expect(res.provider).toBe("gemini");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("uses a forced model name", async () => {
    create.mockResolvedValueOnce(ok("ok"));
    const res = await completeWithTools([{ role: "user", content: "hi" }], { model: "llama-3.1-8b-instant" });
    expect(res.model).toBe("llama-3.1-8b-instant");
    expect(create.mock.calls[0][0]).toMatchObject({ model: "llama-3.1-8b-instant" });
  });
});
