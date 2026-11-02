/**
 * Credit arithmetic. Pure and client-safe.
 *
 * Costs are metered in micro-USD (see src/lib/llm/pricing.ts); credits are
 * milli-USD, so 1 credit = 1000 micros. A markup multiplier (AI_CREDIT_MARKUP,
 * default 1.5) turns provider cost into what the operator is charged.
 */

export const CREDITS_PER_UNIT = 1000;
export const MICROS_PER_CREDIT = 1_000_000 / CREDITS_PER_UNIT; // 1000
export const DEFAULT_MARKUP = 1.5;

/** Markup multiplier from the environment, falling back to the default when unset or invalid. */
export function creditMarkup(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.AI_CREDIT_MARKUP);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MARKUP;
}

/**
 * Provider cost → credits to charge, rounded up so a non-zero cost always
 * charges at least one credit (a zero cost charges nothing).
 */
export function costMicrosToCredits(costMicros: number, markup = creditMarkup()): number {
  const micros = Number(costMicros);
  if (!Number.isFinite(micros) || micros <= 0) return 0;
  return Math.max(1, Math.ceil((micros * markup) / MICROS_PER_CREDIT));
}

export function creditsToUnits(credits: number): number {
  return (Number(credits) || 0) / CREDITS_PER_UNIT;
}

export function unitsToCredits(units: number): number {
  return Math.round((Number(units) || 0) * CREDITS_PER_UNIT);
}

/** "12,345 cr" style label. */
export function formatCredits(credits: number): string {
  return `${new Intl.NumberFormat().format(Math.round(Number(credits) || 0))} cr`;
}

/** Credits as a currency string (USD by default). */
export function formatCreditsAsMoney(credits: number, currency = "USD"): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 3 }).format(creditsToUnits(credits));
}
