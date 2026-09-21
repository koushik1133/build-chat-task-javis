/**
 * USD per 1M tokens: [input, output]. Kept deliberately small and easy to
 * edit; unknown models fall back to a conservative default so caps still bite.
 */
export const PRICES_PER_M: Record<string, [number, number]> = {
  "llama-3.3-70b-versatile": [0.59, 0.79],
  "llama-3.1-8b-instant": [0.05, 0.08],
  "gemini-1.5-flash": [0.075, 0.3],
  "gemini-2.0-flash": [0.1, 0.4],
  "gemini-1.5-pro": [1.25, 5.0],
};

export const DEFAULT_PRICE_PER_M: [number, number] = [1.0, 3.0];

export function estimateCostMicros(model: string, promptTokens: number, completionTokens: number): number {
  const [inP, outP] = PRICES_PER_M[model] ?? DEFAULT_PRICE_PER_M;
  const usd = (promptTokens / 1e6) * inP + (completionTokens / 1e6) * outP;
  return Math.round(usd * 1e6);
}

export const microsToUsd = (micros: number): number => micros / 1e6;
export const usdToMicros = (usd: number): number => Math.round(usd * 1e6);
