import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { tableExists } from "@/lib/table-exists";
import { CurrencySchema } from "@/lib/money/items";
import { CART_LIMITS } from "./pure";

/**
 * Per-org storefront settings. One row per org (user_id = data id); when no
 * row exists the storefront is disabled and the slug defaults to the org slug.
 */

export interface StorefrontExtra {
  max_qty_per_line: number;
  cart_ttl_hours: number;
}

export interface StorefrontDTO {
  enabled: boolean;
  slug: string;
  title: string | null;
  intro_md: string | null;
  currency: string;
  collect_shipping: boolean;
  shipping_flat_minor: number;
  pickup_enabled: boolean;
  terms_md: string | null;
  settings: StorefrontExtra;
  /** False until the org saved the storefront at least once. */
  configured: boolean;
  updated_at: string | null;
}

interface Row {
  user_id: string;
  enabled: boolean;
  slug: string;
  title: string | null;
  intro_md: string | null;
  currency: string;
  collect_shipping: boolean;
  shipping_flat_minor: string | number;
  pickup_enabled: boolean;
  terms_md: string | null;
  settings: string | null;
  updated_at: string | Date | null;
}

const COLS = "user_id, enabled, slug, title, intro_md, currency, collect_shipping, shipping_flat_minor, pickup_enabled, terms_md, settings, updated_at";

export const DEFAULT_EXTRA: StorefrontExtra = { max_qty_per_line: CART_LIMITS.maxQtyPerLine, cart_ttl_hours: 72 };

export function parseExtra(raw: string | null | undefined): StorefrontExtra {
  if (!raw) return { ...DEFAULT_EXTRA };
  try {
    const v: unknown = JSON.parse(raw);
    const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    const mq = Number(o.max_qty_per_line);
    const ttl = Number(o.cart_ttl_hours);
    return {
      max_qty_per_line: Number.isInteger(mq) && mq >= 1 && mq <= 1000 ? mq : DEFAULT_EXTRA.max_qty_per_line,
      cart_ttl_hours: Number.isInteger(ttl) && ttl >= 1 && ttl <= 24 * 30 ? ttl : DEFAULT_EXTRA.cart_ttl_hours,
    };
  } catch {
    return { ...DEFAULT_EXTRA };
  }
}

function toDTO(r: Row): StorefrontDTO {
  return {
    enabled: Boolean(r.enabled),
    slug: r.slug,
    title: r.title,
    intro_md: r.intro_md,
    currency: r.currency,
    collect_shipping: Boolean(r.collect_shipping),
    shipping_flat_minor: Number(r.shipping_flat_minor),
    pickup_enabled: Boolean(r.pickup_enabled),
    terms_md: r.terms_md,
    settings: parseExtra(r.settings),
    configured: true,
    updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  };
}

async function orgSlug(dataId: string): Promise<{ slug: string; name: string } | null> {
  return queryOne<{ slug: string; name: string }>(`SELECT slug, name FROM organizations WHERE owner_user_id = $1 ORDER BY created_at ASC LIMIT 1`, [dataId]).catch(() => null);
}

export function defaultStorefront(slug: string, title: string | null): StorefrontDTO {
  return {
    enabled: false,
    slug,
    title,
    intro_md: null,
    currency: "USD",
    collect_shipping: false,
    shipping_flat_minor: 0,
    pickup_enabled: true,
    terms_md: null,
    settings: { ...DEFAULT_EXTRA },
    configured: false,
    updated_at: null,
  };
}

/** Staff view: the saved row, or defaults derived from the organization. */
export async function getStorefront(dataId: string): Promise<StorefrontDTO> {
  if (await tableExists("storefronts")) {
    const row = await queryOne<Row>(`SELECT ${COLS} FROM storefronts WHERE user_id = $1`, [dataId]);
    if (row) return toDTO(row);
  }
  const org = await orgSlug(dataId);
  return defaultStorefront(org?.slug ?? dataId, org?.name ?? null);
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export const StorefrontPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    slug: z.string().trim().toLowerCase().regex(SLUG_RE, "lowercase letters, digits and dashes").optional(),
    title: z.string().trim().max(120).nullable().optional(),
    intro_md: z.string().max(20_000).nullable().optional(),
    currency: CurrencySchema.optional(),
    collect_shipping: z.boolean().optional(),
    shipping_flat_minor: z.number().int().min(0).max(1_000_000_000).optional(),
    pickup_enabled: z.boolean().optional(),
    terms_md: z.string().max(40_000).nullable().optional(),
    settings: z
      .object({ max_qty_per_line: z.number().int().min(1).max(1000).optional(), cart_ttl_hours: z.number().int().min(1).max(720).optional() })
      .strict()
      .optional(),
  })
  .strict();
export type StorefrontPatch = z.infer<typeof StorefrontPatchSchema>;

/** Upsert the org's storefront row. The slug must not collide with another org's storefront or organization. */
export async function updateStorefront(dataId: string, patch: StorefrontPatch): Promise<StorefrontDTO> {
  const cur = await getStorefront(dataId);
  const next: StorefrontDTO = {
    ...cur,
    ...Object.fromEntries(Object.entries(patch).filter(([k, v]) => v !== undefined && k !== "settings")),
    settings: { ...cur.settings, ...(patch.settings ?? {}) },
    configured: true,
  };
  if (patch.slug !== undefined && patch.slug !== cur.slug) {
    const clashStore = await queryOne<{ user_id: string }>(`SELECT user_id FROM storefronts WHERE slug = $1 AND user_id <> $2`, [patch.slug, dataId]);
    const clashOrg = await queryOne<{ owner_user_id: string }>(`SELECT owner_user_id FROM organizations WHERE slug = $1 AND owner_user_id <> $2`, [patch.slug, dataId]);
    if (clashStore || clashOrg) throw new Error(`Slug "${patch.slug}" is already in use`);
  }
  await query(
    `INSERT INTO storefronts (user_id, enabled, slug, title, intro_md, currency, collect_shipping, shipping_flat_minor, pickup_enabled, terms_md, settings, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled, slug = EXCLUDED.slug, title = EXCLUDED.title, intro_md = EXCLUDED.intro_md,
       currency = EXCLUDED.currency, collect_shipping = EXCLUDED.collect_shipping, shipping_flat_minor = EXCLUDED.shipping_flat_minor,
       pickup_enabled = EXCLUDED.pickup_enabled, terms_md = EXCLUDED.terms_md, settings = EXCLUDED.settings, updated_at = NOW()`,
    [dataId, next.enabled, next.slug, next.title, next.intro_md, next.currency, next.collect_shipping, next.shipping_flat_minor, next.pickup_enabled, next.terms_md, JSON.stringify(next.settings)]
  );
  return getStorefront(dataId);
}

export interface PublicStorefront {
  dataId: string;
  orgName: string;
  storefront: StorefrontDTO;
}

/**
 * Public resolution by slug: the storefront's own slug first, then the
 * organization slug. Only enabled storefronts resolve (null otherwise).
 */
export async function resolveStorefrontBySlug(slug: string): Promise<PublicStorefront | null> {
  if (!slug || slug.length > 80 || !SLUG_RE.test(slug.toLowerCase())) return null;
  if (!(await tableExists("storefronts"))) return null;
  const s = slug.toLowerCase();
  let row = await queryOne<Row>(`SELECT ${COLS} FROM storefronts WHERE slug = $1 AND enabled = TRUE`, [s]);
  if (!row) {
    const org = await queryOne<{ owner_user_id: string }>(`SELECT owner_user_id FROM organizations WHERE slug = $1`, [s]);
    if (!org) return null;
    row = await queryOne<Row>(`SELECT ${COLS} FROM storefronts WHERE user_id = $1 AND enabled = TRUE`, [org.owner_user_id]);
    if (!row) return null;
  }
  const org = await orgSlug(row.user_id);
  return { dataId: row.user_id, orgName: org?.name ?? row.title ?? "Shop", storefront: toDTO(row) };
}
