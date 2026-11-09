import { randomUUID } from "crypto";
import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { CurrencySchema } from "@/lib/money/items";
import { getTaxRate } from "@/lib/money/tax-rates";
import { PLAN_INTERVALS, SEAT_STATUSES, parseBenefits, slugify, type PlanBenefit, type PlanInterval } from "./pure";

/** Membership plans: what a business sells on a recurring basis to its own customers. */

export interface PlanRow {
  id: string;
  user_id: string;
  slug: string;
  name: string;
  description_md: string | null;
  amount_minor: string | number;
  currency: string;
  interval: string;
  interval_count: number;
  trial_days: number;
  setup_fee_minor: string | number;
  tax_rate_id: string | null;
  product_id: string | null;
  max_members: number | null;
  allow_pause: boolean;
  allow_quantity: boolean;
  benefits: string | null;
  visibility: string;
  active: boolean;
  sort: number;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface PlanDTO {
  id: string;
  slug: string;
  name: string;
  description_md: string | null;
  amount_minor: number;
  currency: string;
  interval: PlanInterval;
  interval_count: number;
  trial_days: number;
  setup_fee_minor: number;
  tax_rate_id: string | null;
  product_id: string | null;
  max_members: number | null;
  allow_pause: boolean;
  allow_quantity: boolean;
  benefits: PlanBenefit[];
  visibility: "public" | "private";
  active: boolean;
  sort: number;
  created_at: string;
  updated_at: string;
}

export const PLAN_COLS =
  "id, user_id, slug, name, description_md, amount_minor, currency, interval, interval_count, trial_days, setup_fee_minor, tax_rate_id, product_id, max_members, allow_pause, allow_quantity, benefits, visibility, active, sort, created_at, updated_at";

const iso = (v: string | Date): string => new Date(v).toISOString();

export function toPlanDTO(r: PlanRow): PlanDTO {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    description_md: r.description_md,
    amount_minor: Number(r.amount_minor),
    currency: r.currency,
    interval: (PLAN_INTERVALS as readonly string[]).includes(r.interval) ? (r.interval as PlanInterval) : "month",
    interval_count: Number(r.interval_count),
    trial_days: Number(r.trial_days),
    setup_fee_minor: Number(r.setup_fee_minor),
    tax_rate_id: r.tax_rate_id,
    product_id: r.product_id,
    max_members: r.max_members === null ? null : Number(r.max_members),
    allow_pause: Boolean(r.allow_pause),
    allow_quantity: Boolean(r.allow_quantity),
    benefits: parseBenefits(r.benefits),
    visibility: r.visibility === "private" ? "private" : "public",
    active: Boolean(r.active),
    sort: Number(r.sort),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

export const PlanInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    slug: z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/, "lowercase letters, digits and dashes").optional(),
    description_md: z.string().trim().max(5000).nullable().optional(),
    amount_minor: z.number().int().min(0).max(1_000_000_000),
    currency: CurrencySchema.default("USD"),
    interval: z.enum(PLAN_INTERVALS).default("month"),
    interval_count: z.number().int().min(1).max(24).default(1),
    trial_days: z.number().int().min(0).max(365).default(0),
    setup_fee_minor: z.number().int().min(0).max(1_000_000_000).default(0),
    tax_rate_id: z.string().max(100).nullable().optional(),
    product_id: z.string().max(100).nullable().optional(),
    max_members: z.number().int().min(1).max(1_000_000).nullable().optional(),
    allow_pause: z.boolean().default(true),
    allow_quantity: z.boolean().default(false),
    benefits: z.array(z.object({ label: z.string().trim().min(1).max(200) }).strict()).max(30).default([]),
    visibility: z.enum(["public", "private"]).default("public"),
    sort: z.number().int().min(0).max(100_000).default(0),
  })
  .strict();
export type PlanInput = z.infer<typeof PlanInputSchema>;
/** Currency, interval and count are fixed once created so existing subscribers keep their terms. */
export const PlanPatchSchema = PlanInputSchema.omit({ currency: true, interval: true, interval_count: true, slug: true })
  .partial()
  .extend({ active: z.boolean().optional() })
  .strict();
export type PlanPatch = z.infer<typeof PlanPatchSchema>;

export class MembershipError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = "MembershipError";
  }
}

async function assertTaxRate(dataId: string, id: string | null | undefined): Promise<void> {
  if (!id) return;
  if (!(await getTaxRate(dataId, id))) throw new MembershipError("invalid_tax_rate", "Tax rate not found");
}

async function uniqueSlug(dataId: string, base: string): Promise<string> {
  let slug = base;
  for (let i = 2; i < 50; i++) {
    const hit = await queryOne(`SELECT id FROM membership_plans WHERE user_id = $1 AND slug = $2`, [dataId, slug]);
    if (!hit) return slug;
    slug = `${base.slice(0, 54)}-${i}`;
  }
  return `${base.slice(0, 40)}-${randomUUID().slice(0, 6)}`;
}

export async function createPlan(dataId: string, input: PlanInput): Promise<PlanDTO> {
  await assertTaxRate(dataId, input.tax_rate_id);
  let slug: string;
  if (input.slug) {
    const dup = await queryOne(`SELECT id FROM membership_plans WHERE user_id = $1 AND slug = $2`, [dataId, input.slug]);
    if (dup) throw new MembershipError("slug_taken", "A plan with this link name already exists", 409);
    slug = input.slug;
  } else {
    slug = await uniqueSlug(dataId, slugify(input.name));
  }
  const id = randomUUID();
  await query(
    `INSERT INTO membership_plans (id, user_id, slug, name, description_md, amount_minor, currency, interval, interval_count, trial_days, setup_fee_minor,
       tax_rate_id, product_id, max_members, allow_pause, allow_quantity, benefits, visibility, active, sort)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,TRUE,$19)`,
    [id, dataId, slug, input.name, input.description_md ?? null, input.amount_minor, input.currency, input.interval, input.interval_count, input.trial_days, input.setup_fee_minor,
      input.tax_rate_id ?? null, input.product_id ?? null, input.max_members ?? null, input.allow_pause, input.allow_quantity, JSON.stringify(input.benefits), input.visibility, input.sort]
  );
  const out = await getPlan(dataId, id);
  if (!out) throw new Error("Plan vanished after insert");
  return out;
}

export async function updatePlan(dataId: string, id: string, patch: PlanPatch): Promise<PlanDTO> {
  const cur = await getPlan(dataId, id);
  if (!cur) throw new MembershipError("not_found", "Plan not found", 404);
  if (patch.tax_rate_id !== undefined) await assertTaxRate(dataId, patch.tax_rate_id);
  const next = { ...cur, ...patch, benefits: patch.benefits ?? cur.benefits };
  await query(
    `UPDATE membership_plans SET name = $3, description_md = $4, amount_minor = $5, trial_days = $6, setup_fee_minor = $7, tax_rate_id = $8, product_id = $9,
            max_members = $10, allow_pause = $11, allow_quantity = $12, benefits = $13, visibility = $14, active = $15, sort = $16, updated_at = NOW()
      WHERE id = $1 AND user_id = $2`,
    [id, dataId, next.name, next.description_md ?? null, next.amount_minor, next.trial_days, next.setup_fee_minor, next.tax_rate_id ?? null, next.product_id ?? null,
      next.max_members ?? null, next.allow_pause, next.allow_quantity, JSON.stringify(next.benefits), next.visibility, next.active, next.sort]
  );
  const out = await getPlan(dataId, id);
  if (!out) throw new MembershipError("not_found", "Plan not found", 404);
  return out;
}

/** Archive keeps every existing subscriber on their terms; the plan just stops accepting new members. */
export async function archivePlan(dataId: string, id: string): Promise<PlanDTO> {
  return updatePlan(dataId, id, { active: false });
}

export async function getPlan(dataId: string, id: string): Promise<PlanDTO | null> {
  const r = await queryOne<PlanRow>(`SELECT ${PLAN_COLS} FROM membership_plans WHERE id = $1 AND user_id = $2`, [id, dataId]);
  return r ? toPlanDTO(r) : null;
}

export async function getPlanBySlug(dataId: string, slug: string): Promise<PlanDTO | null> {
  const r = await queryOne<PlanRow>(`SELECT ${PLAN_COLS} FROM membership_plans WHERE user_id = $1 AND slug = $2`, [dataId, slug]);
  return r ? toPlanDTO(r) : null;
}

export async function listPlans(dataId: string, opts: { includeInactive?: boolean } = {}): Promise<Array<PlanDTO & { members: number }>> {
  const rows = await query<PlanRow & { members: string | number }>(
    `SELECT ${PLAN_COLS.split(", ").map((c) => `p.${c}`).join(", ")},
            (SELECT COUNT(*) FROM customer_subscriptions s WHERE s.plan_id = p.id AND s.status IN (${SEAT_STATUSES.map((s) => `'${s}'`).join(",")})) AS members
       FROM membership_plans p WHERE p.user_id = $1 ${opts.includeInactive ? "" : "AND p.active = TRUE"} ORDER BY p.sort ASC, p.created_at ASC LIMIT 200`,
    [dataId]
  );
  return rows.map((r) => ({ ...toPlanDTO(r), members: Number(r.members) }));
}

export async function seatsUsed(planId: string): Promise<number> {
  const r = await queryOne<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM customer_subscriptions WHERE plan_id = $1 AND status IN (${SEAT_STATUSES.map((s) => `'${s}'`).join(",")})`,
    [planId]
  );
  return Number(r?.n ?? 0);
}

/** Unscoped read for the billing engine (the subscription row already carries the tenant). */
export async function getPlanRowById(id: string): Promise<PlanRow | null> {
  return queryOne<PlanRow>(`SELECT ${PLAN_COLS} FROM membership_plans WHERE id = $1`, [id]);
}

/** Public join pages address an org by its slug. */
export async function resolveOrgBySlug(slug: string): Promise<{ dataId: string; name: string } | null> {
  if (!slug || slug.length > 80 || !/^[a-z0-9][a-z0-9-]*$/i.test(slug)) return null;
  const r = await queryOne<{ owner_user_id: string; name: string }>(`SELECT owner_user_id, name FROM organizations WHERE slug = $1`, [slug.toLowerCase()]).catch(() => null);
  return r ? { dataId: r.owner_user_id, name: r.name } : null;
}

export async function orgSlugFor(dataId: string): Promise<string | null> {
  const r = await queryOne<{ slug: string }>(`SELECT slug FROM organizations WHERE owner_user_id = $1 ORDER BY created_at ASC LIMIT 1`, [dataId]).catch(() => null);
  return r?.slug ?? null;
}
