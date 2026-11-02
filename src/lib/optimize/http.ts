import { NextResponse } from "next/server";
import { LlmBudgetExceededError } from "@/lib/llm/budgets";
import { LlmNotConfiguredError } from "@/lib/llm/providers";
import { narrate, type NarrateKind, type Narrative } from "./index";

/**
 * Shared response shaping for /api/optimize/*: the model output is always
 * returned; the narrative is optional and degrades to a status code when the
 * LLM is not configured (503) or the budget is spent (402).
 */
export async function respondWithNarrative<K extends string, T>(
  userId: string,
  kind: NarrateKind,
  key: K,
  data: T,
  wantNarrative: boolean
): Promise<NextResponse> {
  const body: Record<string, unknown> = { [key]: data, narrative: null as Narrative | null };
  if (!wantNarrative) return NextResponse.json(body);
  try {
    body.narrative = await narrate(userId, kind, data);
    return NextResponse.json(body);
  } catch (err) {
    if (err instanceof LlmNotConfiguredError) return NextResponse.json({ ...body, error: "llm_not_configured", detail: err.message }, { status: 503 });
    if (err instanceof LlmBudgetExceededError) return NextResponse.json({ ...body, error: "budget_exceeded", detail: err.message }, { status: 402 });
    console.error(`[optimize/${kind}] narrate failed:`, err);
    return NextResponse.json({ ...body, error: "narrative_failed" }, { status: 502 });
  }
}

export function wantsNarrative(sp: URLSearchParams): boolean {
  const v = sp.get("narrate");
  return v === "1" || v === "true";
}

export function intParam(sp: URLSearchParams, name: string, def: number, min: number, max: number): number {
  const n = Number.parseInt(sp.get(name) ?? "", 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def;
}
