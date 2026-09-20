import { NextResponse } from "next/server";
import { LlmNotConfiguredError } from "@/lib/llm";

/**
 * Map a caught error to a 503 when the cause is missing AI configuration.
 *
 * Returns null for anything else, so callers keep their own error handling:
 *
 *   catch (err) {
 *     const notConfigured = llmNotConfiguredResponse(err);
 *     if (notConfigured) return notConfigured;
 *     ...
 *   }
 */
export function llmNotConfiguredResponse(err: unknown): NextResponse | null {
  const isConfigError =
    err instanceof LlmNotConfiguredError ||
    (err instanceof Error && err.name === "LlmNotConfiguredError");

  if (!isConfigError) return null;

  return NextResponse.json(
    {
      error:
        "AI features are not configured on this deployment. An administrator needs to set GROQ_API_KEY or GEMINI_API_KEY.",
      code: "llm_not_configured",
    },
    { status: 503 }
  );
}
