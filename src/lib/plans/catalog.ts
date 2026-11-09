/**
 * KernelHub plan catalog. Client-safe: no server imports. Prices are minor
 * units; non-USD prices are listed explicitly so nothing converts at runtime.
 */

export const PLAN_KEYS = ["free", "starter", "growth", "scale", "enterprise"] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];
export type BillingInterval = "month" | "year";

export const LIMIT_KEYS = [
  "seats",
  "child_workspaces",
  "contacts",
  "ai_credits_included_per_month",
  "storage_mb",
  "api_rate_limit_per_min",
  "api_keys",
] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];

export const FEATURE_KEYS = [
  "automations_v2",
  "marketplace_publish",
  "sso_scim",
  "white_label",
  "accounting_sync",
  "advanced_reports",
  "webchat_widget",
  "voice_campaigns",
  "custom_domain",
  "priority_support",
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

/** Measured quantities. Metrics that map to a limit are enforceable. */
export const METRICS = ["contacts", "seats", "child_workspaces", "storage_mb", "api_keys", "ai_credits_used", "api_calls"] as const;
export type Metric = (typeof METRICS)[number];

export const METRIC_LIMIT: Record<Metric, LimitKey> = {
  contacts: "contacts",
  seats: "seats",
  child_workspaces: "child_workspaces",
  storage_mb: "storage_mb",
  api_keys: "api_keys",
  ai_credits_used: "ai_credits_included_per_month",
  api_calls: "api_rate_limit_per_min",
};

export const METRIC_LABEL: Record<Metric, string> = {
  contacts: "Contacts",
  seats: "Team seats",
  child_workspaces: "Client workspaces",
  storage_mb: "Storage (MB)",
  api_keys: "API keys",
  ai_credits_used: "AI credits this month",
  api_calls: "API calls this month",
};

export const FEATURE_LABEL: Record<FeatureKey, string> = {
  automations_v2: "Visual automations",
  marketplace_publish: "Publish to marketplace",
  sso_scim: "SSO and SCIM",
  white_label: "White-label branding",
  accounting_sync: "Accounting sync",
  advanced_reports: "Advanced reports and schedules",
  webchat_widget: "Website chat widget",
  voice_campaigns: "Voice campaigns",
  custom_domain: "Custom domain",
  priority_support: "Priority support",
};

export type CurrencyCode = "USD" | "INR" | "EUR" | "GBP";

/** `null` = unlimited. */
export interface PlanEntitlements {
  limits: Record<LimitKey, number | null>;
  features: Record<FeatureKey, boolean>;
  trial_days: number;
}

export interface PlanPrice {
  month: number;
  year: number;
  /** Per extra seat, per month / per year, beyond the seats included in the plan. */
  seatMonth: number;
  seatYear: number;
}

export interface PlanDef {
  key: PlanKey;
  name: string;
  tagline: string;
  /** Self-serve checkout available. Enterprise is contact-us. */
  selfServe: boolean;
  /** Ordering for upgrade/downgrade comparisons. */
  rank: number;
  price: PlanPrice;
  currencyPrices: Partial<Record<Exclude<CurrencyCode, "USD">, PlanPrice>>;
  entitlements: PlanEntitlements;
}

function feats(on: FeatureKey[]): Record<FeatureKey, boolean> {
  const out = {} as Record<FeatureKey, boolean>;
  for (const k of FEATURE_KEYS) out[k] = on.includes(k);
  return out;
}

const P = (month: number, year: number, seatMonth: number, seatYear: number): PlanPrice => ({ month, year, seatMonth, seatYear });

export const PLANS: Readonly<Record<PlanKey, PlanDef>> = {
  free: {
    key: "free",
    name: "Free",
    tagline: "For trying KernelHub with a tiny team.",
    selfServe: true,
    rank: 0,
    price: P(0, 0, 0, 0),
    currencyPrices: {},
    entitlements: {
      limits: { seats: 2, child_workspaces: 0, contacts: 250, ai_credits_included_per_month: 0, storage_mb: 250, api_rate_limit_per_min: 30, api_keys: 1 },
      features: feats(["webchat_widget"]),
      trial_days: 0,
    },
  },
  starter: {
    key: "starter",
    name: "Starter",
    tagline: "Everything a small team needs to run the day.",
    selfServe: true,
    rank: 1,
    price: P(2900, 29000, 500, 5000),
    currencyPrices: {
      INR: P(239900, 2399000, 39900, 399000),
      EUR: P(2700, 27000, 500, 5000),
      GBP: P(2300, 23000, 400, 4000),
    },
    entitlements: {
      limits: { seats: 5, child_workspaces: 0, contacts: 2_500, ai_credits_included_per_month: 5_000, storage_mb: 2_048, api_rate_limit_per_min: 60, api_keys: 5 },
      features: feats(["automations_v2", "webchat_widget", "accounting_sync"]),
      trial_days: 0,
    },
  },
  growth: {
    key: "growth",
    name: "Growth",
    tagline: "Automation, reporting and a bigger team.",
    selfServe: true,
    rank: 2,
    price: P(7900, 79000, 1000, 10000),
    currencyPrices: {
      INR: P(649900, 6499000, 79900, 799000),
      EUR: P(7300, 73000, 900, 9000),
      GBP: P(6300, 63000, 800, 8000),
    },
    entitlements: {
      limits: { seats: 15, child_workspaces: 3, contacts: 25_000, ai_credits_included_per_month: 25_000, storage_mb: 20_480, api_rate_limit_per_min: 300, api_keys: 20 },
      features: feats(["automations_v2", "marketplace_publish", "accounting_sync", "advanced_reports", "webchat_widget", "voice_campaigns", "custom_domain"]),
      trial_days: 14,
    },
  },
  scale: {
    key: "scale",
    name: "Scale",
    tagline: "Agencies and multi-team organisations.",
    selfServe: true,
    rank: 3,
    price: P(19900, 199000, 1500, 15000),
    currencyPrices: {
      INR: P(1649900, 16499000, 119900, 1199000),
      EUR: P(18500, 185000, 1400, 14000),
      GBP: P(15900, 159000, 1200, 12000),
    },
    entitlements: {
      limits: { seats: 50, child_workspaces: 25, contacts: 250_000, ai_credits_included_per_month: 100_000, storage_mb: 204_800, api_rate_limit_per_min: 1_200, api_keys: 100 },
      features: feats([...FEATURE_KEYS]),
      trial_days: 0,
    },
  },
  enterprise: {
    key: "enterprise",
    name: "Enterprise",
    tagline: "Custom limits, security reviews and a named contact.",
    selfServe: false,
    rank: 4,
    price: P(0, 0, 0, 0),
    currencyPrices: {},
    entitlements: {
      limits: { seats: null, child_workspaces: null, contacts: null, ai_credits_included_per_month: null, storage_mb: null, api_rate_limit_per_min: 6_000, api_keys: null },
      features: feats([...FEATURE_KEYS]),
      trial_days: 0,
    },
  },
};

/** Plan a new organisation trials. */
export const TRIAL_PLAN: PlanKey = "growth";
export const TRIAL_DAYS = 14;

export function isPlanKey(v: unknown): v is PlanKey {
  return typeof v === "string" && (PLAN_KEYS as readonly string[]).includes(v);
}
export function isBillingInterval(v: unknown): v is BillingInterval {
  return v === "month" || v === "year";
}
export function getPlan(key: string): PlanDef | null {
  return isPlanKey(key) ? PLANS[key] : null;
}
export function listPlans(): PlanDef[] {
  return PLAN_KEYS.map((k) => PLANS[k]);
}

/** Currencies with an explicit price list for `plan`; USD always works. */
export function priceCurrency(plan: PlanDef, currency: string): CurrencyCode {
  const c = currency.toUpperCase();
  return c !== "USD" && plan.currencyPrices[c as Exclude<CurrencyCode, "USD">] ? (c as CurrencyCode) : "USD";
}

/** Price list for a currency (falls back to USD when the plan has no price in it). */
export function planPriceIn(plan: PlanDef, currency: string): { currency: CurrencyCode; price: PlanPrice } {
  const cur = priceCurrency(plan, currency);
  return { currency: cur, price: cur === "USD" ? plan.price : (plan.currencyPrices[cur as Exclude<CurrencyCode, "USD">] as PlanPrice) };
}

/** Total for one period: base plus seats beyond what the plan includes. */
export function periodAmountMinor(plan: PlanDef, interval: BillingInterval, currency: string, seats: number): { amountMinor: number; currency: CurrencyCode } {
  const { currency: cur, price } = planPriceIn(plan, currency);
  const included = plan.entitlements.limits.seats ?? seats;
  const extra = Math.max(0, Math.trunc(seats) - included);
  const base = interval === "year" ? price.year : price.month;
  const perSeat = interval === "year" ? price.seatYear : price.seatMonth;
  return { amountMinor: base + extra * perSeat, currency: cur };
}

/** "Save X%" for annual billing relative to 12 monthly payments. */
export function annualSavingsPercent(plan: PlanDef): number {
  if (plan.price.month <= 0) return 0;
  return Math.round((1 - plan.price.year / (plan.price.month * 12)) * 100);
}

/** Cheapest self-serve plan whose `limit` fits `needed` (null when none/unlimited-only). */
export function suggestUpgrade(current: PlanKey, limit: LimitKey, needed: number): PlanKey | null {
  const cur = PLANS[current].rank;
  for (const p of listPlans()) {
    if (p.rank <= cur) continue;
    const v = p.entitlements.limits[limit];
    if (v === null || v >= needed) return p.key;
  }
  return null;
}

export function suggestFeaturePlan(current: PlanKey, feature: FeatureKey): PlanKey | null {
  const cur = PLANS[current].rank;
  for (const p of listPlans()) if (p.rank > cur && p.entitlements.features[feature]) return p.key;
  return null;
}
