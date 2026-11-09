/**
 * Engagement pure helpers (client-safe: no DB, no node crypto, no clock beyond
 * what callers pass). Survey maths, voucher rules, discount allocation, loyalty
 * tiers and referral fraud guards live here so they are unit-testable and the
 * staff UI can import them.
 */
import { z } from "zod";
import type { LineItem } from "@/lib/money/items";

/* ── surveys ───────────────────────────────────────────────────────────── */

export const SURVEY_KINDS = ["nps", "csat", "custom"] as const;
export type SurveyKind = (typeof SURVEY_KINDS)[number];
export const SURVEY_CHANNELS = ["email", "sms", "link"] as const;
export type SurveyChannel = (typeof SURVEY_CHANNELS)[number];
export const QUESTION_TYPES = ["rating", "nps", "text", "choice"] as const;

export const QuestionSchema = z
  .object({
    id: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/),
    type: z.enum(QUESTION_TYPES),
    label: z.string().trim().min(1).max(300),
    required: z.boolean().optional(),
    options: z.array(z.string().trim().min(1).max(120)).max(12).optional(),
  })
  .strict();
export type Question = z.infer<typeof QuestionSchema>;
export const QuestionsSchema = z.array(QuestionSchema).min(1).max(12);

export function parseQuestions(raw: string | null | undefined): Question[] {
  if (!raw) return [];
  try {
    const r = QuestionsSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : [];
  } catch {
    return [];
  }
}

export function defaultQuestions(kind: SurveyKind): Question[] {
  if (kind === "nps") return [{ id: "score", type: "nps", label: "How likely are you to recommend us to a friend or colleague?", required: true }, { id: "comment", type: "text", label: "What is the main reason for your score?" }];
  if (kind === "csat") return [{ id: "score", type: "rating", label: "How satisfied were you with your experience?", required: true }, { id: "comment", type: "text", label: "Anything we could do better?" }];
  return [{ id: "q1", type: "text", label: "Tell us how we did", required: true }];
}

/** Score range for the primary question of a survey kind. */
export function scoreRange(kind: SurveyKind, qtype?: string): { min: number; max: number } {
  if (kind === "nps" || qtype === "nps") return { min: 0, max: 10 };
  return { min: 1, max: 5 };
}

export interface NpsStats {
  total: number;
  promoters: number;
  passives: number;
  detractors: number;
  /** -100..100, null when there are no responses. */
  nps: number | null;
}
export function npsStats(scores: readonly number[]): NpsStats {
  const valid = scores.filter((s) => Number.isFinite(s) && s >= 0 && s <= 10);
  let p = 0;
  let d = 0;
  for (const s of valid) {
    if (s >= 9) p++;
    else if (s <= 6) d++;
  }
  const total = valid.length;
  return { total, promoters: p, passives: total - p - d, detractors: d, nps: total === 0 ? null : Math.round(((p - d) / total) * 100) };
}

export interface CsatStats {
  total: number;
  satisfied: number;
  /** % of 4-5 ratings, null with no responses. */
  csat: number | null;
  average: number | null;
}
export function csatStats(scores: readonly number[]): CsatStats {
  const valid = scores.filter((s) => Number.isFinite(s) && s >= 1 && s <= 5);
  const total = valid.length;
  const satisfied = valid.filter((s) => s >= 4).length;
  const sum = valid.reduce((a, b) => a + b, 0);
  return { total, satisfied, csat: total === 0 ? null : Math.round((satisfied / total) * 100), average: total === 0 ? null : Math.round((sum / total) * 100) / 100 };
}

/** Detractor threshold: NPS <= 6, CSAT <= 2. Custom surveys have no automatic alert. */
export function isDetractor(kind: SurveyKind, score: number | null): boolean {
  if (score === null || !Number.isFinite(score)) return false;
  if (kind === "nps") return score <= 6;
  if (kind === "csat") return score <= 2;
  return false;
}

/** Public review prompt is offered only for promoters (NPS >= 9 or a 5-star CSAT). */
export function qualifiesForReviewPrompt(kind: SurveyKind, score: number | null): boolean {
  if (score === null) return false;
  return kind === "nps" ? score >= 9 : kind === "csat" ? score >= 5 : false;
}

/** Only https URLs are ever shown as a review link. */
export function safeReviewUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

/** ISO date (Monday) of the week containing `d`, UTC. */
export function weekStart(d: Date): string {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (x.getUTCDay() + 6) % 7;
  x.setUTCDate(x.getUTCDate() - dow);
  return x.toISOString().slice(0, 10);
}

export function trendByWeek(rows: ReadonlyArray<{ score: number | null; created_at: string | Date }>, kind: SurveyKind): Array<{ week: string; responses: number; value: number | null }> {
  const buckets = new Map<string, number[]>();
  for (const r of rows) {
    if (r.score === null) continue;
    const w = weekStart(new Date(r.created_at));
    const arr = buckets.get(w) ?? [];
    arr.push(r.score);
    buckets.set(w, arr);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, scores]) => ({ week, responses: scores.length, value: kind === "csat" ? csatStats(scores).csat : npsStats(scores).nps }));
}

/** Distribution counts for a 0-10 / 1-5 scale. */
export function distribution(scores: readonly number[], min: number, max: number): number[] {
  const out = new Array<number>(max - min + 1).fill(0);
  for (const s of scores) if (Number.isInteger(s) && s >= min && s <= max) out[s - min]++;
  return out;
}

/* ── vouchers ──────────────────────────────────────────────────────────── */

export const VOUCHER_KINDS = ["percent", "fixed", "free_shipping"] as const;
export type VoucherKind = (typeof VOUCHER_KINDS)[number];
export const VOUCHER_APPLIES = ["all", "products", "categories"] as const;
export type VoucherApplies = (typeof VOUCHER_APPLIES)[number];

export interface VoucherLike {
  id: string;
  code_upper: string;
  kind: VoucherKind;
  /** percent: basis points (1000 = 10%); fixed: minor units; free_shipping: ignored. */
  value: number;
  currency: string | null;
  min_subtotal_minor: number;
  max_uses: number | null;
  per_contact_limit: number | null;
  used_count: number;
  starts_at: string | null;
  ends_at: string | null;
  applies_to: VoucherApplies;
  applies_config: { product_ids?: string[]; kinds?: string[] } | null;
  stackable: boolean;
  active: boolean;
}

export type VoucherRejection = "inactive" | "not_started" | "expired" | "exhausted" | "contact_limit" | "min_subtotal" | "currency" | "not_applicable" | "not_stackable";
export const VOUCHER_MESSAGES: Record<VoucherRejection, string> = {
  inactive: "This code is not valid.",
  not_started: "This code is not active yet.",
  expired: "This code has expired.",
  exhausted: "This code has been fully redeemed.",
  contact_limit: "You have already used this code the maximum number of times.",
  min_subtotal: "Your order does not reach the minimum spend for this code.",
  currency: "This code is not valid for this currency.",
  not_applicable: "This code does not apply to the items in your order.",
  not_stackable: "This code cannot be combined with another discount.",
};

export interface DiscountItem {
  product_id?: string | null;
  kind?: string | null;
  /** Line subtotal (qty x unit), before tax. */
  line_minor: number;
}

export interface VoucherContext {
  now: Date;
  currency: string;
  subtotalMinor: number;
  items: readonly DiscountItem[];
  /** Redemptions of this voucher already used by the contact. */
  contactUses: number;
}

export type VoucherEvaluation =
  | { ok: true; discountMinor: number; freeShipping: boolean; eligibleMinor: number }
  | { ok: false; reason: VoucherRejection; message: string };

const reject = (reason: VoucherRejection): VoucherEvaluation => ({ ok: false, reason, message: VOUCHER_MESSAGES[reason] });

export function eligibleSubtotal(v: Pick<VoucherLike, "applies_to" | "applies_config">, items: readonly DiscountItem[]): number {
  if (v.applies_to === "all") return items.reduce((s, i) => s + Math.max(0, i.line_minor), 0);
  const cfg = v.applies_config ?? {};
  if (v.applies_to === "products") {
    const ids = new Set(cfg.product_ids ?? []);
    return items.filter((i) => i.product_id && ids.has(i.product_id)).reduce((s, i) => s + Math.max(0, i.line_minor), 0);
  }
  const kinds = new Set((cfg.kinds ?? []).map((k) => k.toLowerCase()));
  return items.filter((i) => i.kind && kinds.has(i.kind.toLowerCase())).reduce((s, i) => s + Math.max(0, i.line_minor), 0);
}

/** Pure: does this voucher apply, and what does it take off? Never exceeds the eligible subtotal. */
export function evaluateVoucher(v: VoucherLike, ctx: VoucherContext): VoucherEvaluation {
  if (!v.active) return reject("inactive");
  if (v.starts_at && new Date(v.starts_at).getTime() > ctx.now.getTime()) return reject("not_started");
  if (v.ends_at && new Date(v.ends_at).getTime() < ctx.now.getTime()) return reject("expired");
  if (v.max_uses !== null && v.used_count >= v.max_uses) return reject("exhausted");
  if (v.per_contact_limit !== null && ctx.contactUses >= v.per_contact_limit) return reject("contact_limit");
  if (v.kind === "fixed" && v.currency && v.currency.toUpperCase() !== ctx.currency.toUpperCase()) return reject("currency");
  if (ctx.subtotalMinor < v.min_subtotal_minor) return reject("min_subtotal");
  const eligible = eligibleSubtotal(v, ctx.items);
  if (v.kind === "free_shipping") return { ok: true, discountMinor: 0, freeShipping: true, eligibleMinor: eligible };
  if (eligible <= 0) return reject("not_applicable");
  const raw = v.kind === "percent" ? Math.floor((eligible * Math.min(Math.max(v.value, 0), 10_000)) / 10_000 + 0.5) : Math.max(0, v.value);
  return { ok: true, discountMinor: Math.min(raw, eligible), freeShipping: false, eligibleMinor: eligible };
}

/** Pure: a non-stackable voucher must be the only discount code in the order. */
export function checkStacking(vouchers: ReadonlyArray<Pick<VoucherLike, "id" | "stackable">>): { ok: true } | { ok: false; offending: string } {
  if (vouchers.length <= 1) return { ok: true };
  const bad = vouchers.find((v) => !v.stackable);
  return bad ? { ok: false, offending: bad.id } : { ok: true };
}

export const VoucherInputSchema = z
  .object({
    code: z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9_-]+$/, "Letters, numbers, dash and underscore only"),
    name: z.string().trim().min(1).max(120),
    kind: z.enum(VOUCHER_KINDS),
    value: z.number().int().min(0).max(1_000_000_000),
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).nullable().optional(),
    min_subtotal_minor: z.number().int().min(0).max(1_000_000_000_000).optional(),
    max_uses: z.number().int().min(1).max(10_000_000).nullable().optional(),
    per_contact_limit: z.number().int().min(1).max(10_000).nullable().optional(),
    starts_at: z.string().datetime({ offset: true }).nullable().optional(),
    ends_at: z.string().datetime({ offset: true }).nullable().optional(),
    applies_to: z.enum(VOUCHER_APPLIES).optional(),
    applies_config: z.object({ product_ids: z.array(z.string().max(100)).max(200).optional(), kinds: z.array(z.string().max(40)).max(20).optional() }).strict().nullable().optional(),
    stackable: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.kind === "percent" && (v.value < 1 || v.value > 10_000)) ctx.addIssue({ code: "custom", path: ["value"], message: "Percent is in basis points: 1-10000" });
    if (v.kind === "fixed" && v.value < 1) ctx.addIssue({ code: "custom", path: ["value"], message: "Fixed amount must be positive" });
    if (v.kind === "fixed" && !v.currency) ctx.addIssue({ code: "custom", path: ["currency"], message: "Fixed vouchers need a currency" });
    if (v.starts_at && v.ends_at && new Date(v.ends_at) <= new Date(v.starts_at)) ctx.addIssue({ code: "custom", path: ["ends_at"], message: "End must be after start" });
  });
export type VoucherInput = z.infer<typeof VoucherInputSchema>;

/* ── discount allocation (tax-aware) ───────────────────────────────────── */

/**
 * Pure: turn a total discount into negative line items, one per distinct tax
 * treatment, allocated pro-rata to each group's goods subtotal (remainder to
 * the largest group). Because the discount lines carry the same tax rate as
 * the goods they discount, the tax engine reduces tax by exactly the right
 * amount: discounts apply BEFORE tax. For tax-inclusive pricing the same lines
 * reduce the (inclusive) price and the engine backs tax out of the reduced
 * total, so the customer's saving equals the discount amount either way.
 */
export function discountLines(goods: readonly LineItem[], discountMinor: number, description: string): LineItem[] {
  const groups = new Map<string, { sample: LineItem; subtotal: number }>();
  for (const it of goods) {
    if (it.unit_minor <= 0) continue;
    const sub = Math.floor(it.qty * it.unit_minor + 0.5);
    const key = JSON.stringify([it.tax_rate_bp ?? 0, it.tax_rate_id ?? null, it.tax_rate_ids ?? null]);
    const g = groups.get(key);
    if (g) g.subtotal += sub;
    else groups.set(key, { sample: it, subtotal: sub });
  }
  const list = [...groups.values()].filter((g) => g.subtotal > 0);
  const total = list.reduce((s, g) => s + g.subtotal, 0);
  const amount = Math.min(Math.max(0, Math.trunc(discountMinor)), total);
  if (amount <= 0 || list.length === 0) return [];
  list.sort((a, b) => b.subtotal - a.subtotal);
  let allocated = 0;
  const parts = list.map((g) => {
    const share = Math.floor((amount * g.subtotal) / total);
    allocated += share;
    return share;
  });
  parts[0] += amount - allocated;
  const out: LineItem[] = [];
  list.forEach((g, i) => {
    if (parts[i] <= 0) return;
    const line: LineItem = { description, qty: 1, unit_minor: -parts[i], tax_rate_bp: g.sample.tax_rate_bp ?? 0 };
    if (g.sample.tax_rate_id) line.tax_rate_id = g.sample.tax_rate_id;
    if (g.sample.tax_rate_ids) line.tax_rate_ids = g.sample.tax_rate_ids;
    out.push(line);
  });
  return out;
}

/* ── loyalty ───────────────────────────────────────────────────────────── */

export const LOYALTY_KINDS = ["earn", "redeem", "adjust", "expire", "referral"] as const;
export type LoyaltyKind = (typeof LOYALTY_KINDS)[number];

export const TierSchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    min_points: z.number().int().min(0).max(1_000_000_000),
    multiplier: z.number().min(1).max(10),
    perks: z.string().trim().max(300).optional(),
  })
  .strict();
export type Tier = z.infer<typeof TierSchema>;
export const TiersSchema = z.array(TierSchema).max(8);

export interface LoyaltyProgram {
  enabled: boolean;
  /** `earn_points` points per `per_minor` minor units spent (e.g. 1 point per 100 cents). */
  earn_points: number;
  per_minor: number;
  redeem_value_minor_per_point: number;
  tiers: Tier[];
  expiry_months: number | null;
  min_redeem_points: number;
  /** Max share of the subtotal points may pay for, in basis points. */
  max_redeem_pct_bp: number;
}

export const DEFAULT_PROGRAM: LoyaltyProgram = { enabled: false, earn_points: 1, per_minor: 100, redeem_value_minor_per_point: 1, tiers: [], expiry_months: null, min_redeem_points: 100, max_redeem_pct_bp: 5000 };

export function parseTiers(raw: string | null | undefined): Tier[] {
  if (!raw) return [];
  try {
    const r = TiersSchema.safeParse(JSON.parse(raw));
    return r.success ? [...r.data].sort((a, b) => a.min_points - b.min_points) : [];
  } catch {
    return [];
  }
}

/** Highest tier whose threshold the lifetime points reach, else null. */
export function tierFor(tiers: readonly Tier[], lifetimePoints: number): Tier | null {
  let best: Tier | null = null;
  for (const t of [...tiers].sort((a, b) => a.min_points - b.min_points)) if (lifetimePoints >= t.min_points) best = t;
  return best;
}

export function pointsForAmount(p: Pick<LoyaltyProgram, "earn_points" | "per_minor">, amountMinor: number, multiplier = 1): number {
  if (!(amountMinor > 0) || p.per_minor <= 0 || p.earn_points <= 0) return 0;
  return Math.floor((Math.floor(amountMinor) * p.earn_points * multiplier) / p.per_minor);
}

export function pointsValueMinor(p: Pick<LoyaltyProgram, "redeem_value_minor_per_point">, points: number): number {
  return Math.max(0, Math.trunc(points)) * p.redeem_value_minor_per_point;
}

/** Most points the shopper may spend on an order: balance, the % cap and the minimum are all respected. */
export function maxRedeemablePoints(p: LoyaltyProgram, balance: number, subtotalMinor: number): number {
  if (!p.enabled || p.redeem_value_minor_per_point <= 0 || balance < p.min_redeem_points) return 0;
  const capMinor = Math.floor((subtotalMinor * p.max_redeem_pct_bp) / 10_000);
  const byCap = Math.floor(capMinor / p.redeem_value_minor_per_point);
  const max = Math.min(Math.trunc(balance), byCap);
  return max < p.min_redeem_points ? 0 : max;
}

/**
 * Pure expiry computation (documented simplification of FIFO): points earned
 * before `cutoff` count as expired except for what the member has since spent
 * or already had expired. Spending is assumed to consume the oldest points
 * first, so expirable = max(0, earnedBeforeCutoff - totalSpentAndExpired),
 * capped at the current balance.
 */
export function expirablePoints(entries: ReadonlyArray<{ kind: LoyaltyKind; points: number; created_at: string | Date }>, cutoff: Date, balance: number): number {
  let earnedOld = 0;
  let consumed = 0;
  for (const e of entries) {
    const old = new Date(e.created_at).getTime() < cutoff.getTime();
    if ((e.kind === "earn" || e.kind === "referral" || e.kind === "adjust") && e.points > 0) {
      if (old) earnedOld += e.points;
    } else if (e.points < 0) consumed += -e.points;
  }
  return Math.max(0, Math.min(earnedOld - consumed, balance));
}

export const ProgramPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    earn_points: z.number().int().min(1).max(10_000).optional(),
    per_minor: z.number().int().min(1).max(1_000_000_000).optional(),
    redeem_value_minor_per_point: z.number().int().min(1).max(1_000_000).optional(),
    tiers: TiersSchema.optional(),
    expiry_months: z.number().int().min(1).max(120).nullable().optional(),
    min_redeem_points: z.number().int().min(0).max(1_000_000).optional(),
    max_redeem_pct_bp: z.number().int().min(100).max(10_000).optional(),
  })
  .strict();

/* ── referrals ─────────────────────────────────────────────────────────── */

export interface ReferralParty {
  id: string | null;
  email?: string | null;
  phone?: string | null;
}
const normEmail = (e?: string | null) => (e ?? "").trim().toLowerCase();
const normPhone = (p?: string | null) => (p ?? "").replace(/[^0-9]/g, "").replace(/^0+/, "");

/** Pure: self-referral = same contact, same email (ignoring +tags / dots for gmail-style), or same phone. */
export function isSelfReferral(referrer: ReferralParty, referee: ReferralParty): boolean {
  if (referrer.id && referee.id && referrer.id === referee.id) return true;
  const canon = (e: string) => {
    const [local, domain] = e.split("@");
    if (!domain) return e;
    return `${local.split("+")[0].replace(/\./g, "")}@${domain}`;
  };
  const a = normEmail(referrer.email);
  const b = normEmail(referee.email);
  if (a && b && canon(a) === canon(b)) return true;
  const pa = normPhone(referrer.phone);
  const pb = normPhone(referee.phone);
  return Boolean(pa && pb && pa.length >= 6 && pa === pb);
}

export interface ReferralPolicy {
  reward_points: number;
  min_amount_minor: number;
  monthly_cap: number;
}
export const DEFAULT_REFERRAL_POLICY: ReferralPolicy = { reward_points: 500, min_amount_minor: 1, monthly_cap: 20 };

export type ReferralBlock = "self_referral" | "already_rewarded" | "monthly_cap" | "below_minimum";
export function referralGuard(args: { self: boolean; refereeAlreadyRewarded: boolean; rewardedThisMonth: number; amountMinor: number; policy: ReferralPolicy }): ReferralBlock | null {
  if (args.self) return "self_referral";
  if (args.refereeAlreadyRewarded) return "already_rewarded";
  if (args.amountMinor < args.policy.min_amount_minor) return "below_minimum";
  if (args.rewardedThisMonth >= args.policy.monthly_cap) return "monthly_cap";
  return null;
}

/* ── gift card limiter keys ────────────────────────────────────────────── */

/** Normalise user input: strip separators/spaces, uppercase. */
export function normalizeGiftCode(raw: string): string {
  return raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}
export function isWellFormedGiftCode(raw: string): boolean {
  return /^[A-Z2-9]{16}$/.test(normalizeGiftCode(raw)) && !/[IO]/.test(normalizeGiftCode(raw));
}
export function formatGiftCode(normalized: string): string {
  return normalized.match(/.{1,4}/g)?.join("-") ?? normalized;
}
