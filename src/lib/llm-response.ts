import { NextResponse } from "next/server";
import { LlmNotConfiguredError } from "@/lib/llm/providers";
import { LlmBudgetExceededError } from "@/lib/llm/budgets";
import { isInsufficientCreditsError } from "@/lib/credits/errors";

/**
 * Map a caught LLM error to an HTTP response:
 *
 *   - missing AI configuration → 503 `llm_not_configured`
 *   - monthly spend cap reached → 402 `llm_budget_exceeded`
 *   - AI credits enforced and exhausted → 402 `credits_exhausted`
 *
 * Returns null for anything else, so callers keep their own error handling:
 *
 *   catch (err) {
 *     const mapped = llmErrorResponse(err);
 *     if (mapped) return mapped;
 *     ...
 *   }
 */
export function llmErrorResponse(err: unknown): NextResponse | null {
  const name = err instanceof Error ? err.name : "";

  if (err instanceof LlmNotConfiguredError || name === "LlmNotConfiguredError") {
    return NextResponse.json(
      {
        error:
          "AI features are not configured on this deployment. An administrator needs to set GROQ_API_KEY or GEMINI_API_KEY.",
        code: "llm_not_configured",
      },
      { status: 503 }
    );
  }

  if (err instanceof LlmBudgetExceededError || name === "LlmBudgetExceededError") {
    return NextResponse.json(
      { error: (err as Error).message, code: "llm_budget_exceeded" },
      { status: 402 }
    );
  }

  if (isInsufficientCreditsError(err)) {
    return NextResponse.json({ error: err.message, code: "credits_exhausted", balance: err.balance }, { status: 402 });
  }

  return null;
}

/** @deprecated Use `llmErrorResponse`; kept for existing callers. */
export const llmNotConfiguredResponse = llmErrorResponse;
