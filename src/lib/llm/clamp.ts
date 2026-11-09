/** Apply the org's per-call output ceiling (ai_budgets.max_tokens_per_call) to a requested max_tokens. Only ever lowers it. */
export function clampMaxTokens(b: { maxTokensPerCall: number | null }, requested: number): number {
  return b.maxTokensPerCall != null && b.maxTokensPerCall > 0 ? Math.min(requested, b.maxTokensPerCall) : requested;
}
