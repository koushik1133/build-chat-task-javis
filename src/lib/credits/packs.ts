/**
 * Static credit-pack catalog. Client-safe (no DB imports) so the settings page
 * can render it directly.
 *
 * 1 credit = 1/1000 of a unit of currency (USD), i.e. 1000 credits = $1.
 */
export interface CreditPack {
  id: string;
  name: string;
  credits: number;
  price_minor: number;
  currency: string;
  blurb: string;
}

export const CREDIT_PACKS: readonly CreditPack[] = [
  { id: "starter", name: "Starter", credits: 10_000, price_minor: 1_000, currency: "USD", blurb: "About a month of light agent use." },
  { id: "growth", name: "Growth", credits: 60_000, price_minor: 5_000, currency: "USD", blurb: "20% more credits per dollar." },
  { id: "scale", name: "Scale", credits: 150_000, price_minor: 10_000, currency: "USD", blurb: "50% more credits per dollar." },
] as const;

export function getPack(id: string): CreditPack | null {
  return CREDIT_PACKS.find((p) => p.id === id) ?? null;
}

/** Credits granted to every account on first use. */
export const FREE_GRANT_CREDITS = 5_000;
