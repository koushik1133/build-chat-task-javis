import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { tableExists } from "@/lib/table-exists";
import { builtinListings, getBuiltinListing } from "./builtin";
import { exportAsListing } from "./export";
import {
  isBuiltinId,
  matchesQuery,
  parseDefinition,
  ratingAvg,
  slugifyListing,
  sortListings,
  type CatalogQuery,
  type ListingDTO,
  type ListingKind,
  type ReviewDTO,
  type Visibility,
} from "./types";

/**
 * Catalog reads/writes. Listings are keyed by the publisher's org data id;
 * public listings are visible to everyone, private/org ones only to the org
 * that owns them. Built-in listings come from code (builtin.ts) and are merged
 * in so the marketplace works before the Phase 4 tables exist.
 */

interface ListingRow {
  id: string;
  user_id: string;
  kind: ListingKind;
  slug: string;
  title: string;
  summary: string | null;
  description_md: string | null;
  category: string | null;
  tags: string | null;
  definition: string | null;
  version: number;
  visibility: Visibility;
  install_count: number;
  rating_sum: number;
  rating_count: number;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

const COLS = "id, user_id, kind, slug, title, summary, description_md, category, tags, definition, version, visibility, install_count, rating_sum, rating_count, created_at, updated_at, published_at";

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToDTO(r: ListingRow, dataId: string | null): ListingDTO {
  const sum = Number(r.rating_sum) || 0;
  const count = Number(r.rating_count) || 0;
  const owner = dataId !== null && r.user_id === dataId;
  return {
    id: r.id,
    kind: r.kind,
    slug: r.slug,
    title: r.title,
    summary: r.summary,
    description_md: r.description_md,
    category: r.category,
    tags: parseJson<string[]>(r.tags, []).filter((t): t is string => typeof t === "string"),
    definition: parseJson<unknown>(r.definition, null),
    version: Number(r.version) || 1,
    visibility: r.visibility,
    install_count: Number(r.install_count) || 0,
    rating_sum: sum,
    rating_count: count,
    rating_avg: ratingAvg(sum, count),
    builtin: false,
    publisher: owner ? "you" : "community",
    owner,
    installed: false,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    published_at: r.published_at ? String(r.published_at) : null,
  };
}

async function hasTables(): Promise<boolean> {
  return tableExists("marketplace_listings");
}

/** Listing ids the org has installed (any version), or an empty set when the table is missing. */
async function installedIds(dataId: string): Promise<Map<string, number>> {
  const rows = await query<{ listing_id: string; version: number }>(`SELECT listing_id, MAX(version) AS version FROM marketplace_installs WHERE user_id = $1 GROUP BY listing_id`, [dataId]).catch(() => []);
  return new Map(rows.map((r) => [r.listing_id, Number(r.version)]));
}

/** Ratings for built-in ids live only in the reviews table. */
async function builtinRatings(): Promise<Map<string, { sum: number; count: number }>> {
  const rows = await query<{ listing_id: string; sum: string | number; count: string | number }>(
    `SELECT listing_id, SUM(rating) AS sum, COUNT(*) AS count FROM marketplace_reviews WHERE listing_id LIKE 'builtin:%' GROUP BY listing_id`
  ).catch(() => []);
  return new Map(rows.map((r) => [r.listing_id, { sum: Number(r.sum), count: Number(r.count) }]));
}

async function builtinInstallCounts(): Promise<Map<string, number>> {
  const rows = await query<{ listing_id: string; n: string | number }>(
    `SELECT listing_id, COUNT(DISTINCT user_id) AS n FROM marketplace_installs WHERE listing_id LIKE 'builtin:%' GROUP BY listing_id`
  ).catch(() => []);
  return new Map(rows.map((r) => [r.listing_id, Number(r.n)]));
}

function annotateBuiltin(l: ListingDTO, ratings: Map<string, { sum: number; count: number }>, installs: Map<string, number>, mine: Map<string, number>): ListingDTO {
  const r = ratings.get(l.id);
  return {
    ...l,
    rating_sum: r?.sum ?? 0,
    rating_count: r?.count ?? 0,
    rating_avg: r ? ratingAvg(r.sum, r.count) : null,
    install_count: installs.get(l.id) ?? 0,
    installed: mine.has(l.id),
  };
}

/** Public + the org's own listings + built-ins, filtered and sorted. */
export async function listCatalog(dataId: string, q: CatalogQuery = {}): Promise<ListingDTO[]> {
  const ready = await hasTables();
  const [mine, ratings, installs] = ready ? await Promise.all([installedIds(dataId), builtinRatings(), builtinInstallCounts()]) : [new Map<string, number>(), new Map(), new Map()];
  let all: ListingDTO[] = builtinListings().map((l) => annotateBuiltin(l, ratings, installs, mine));
  if (ready) {
    const rows = await query<ListingRow>(
      `SELECT ${COLS} FROM marketplace_listings
        WHERE (visibility = 'public' AND published_at IS NOT NULL) OR user_id = $1
        ORDER BY updated_at DESC LIMIT 500`,
      [dataId]
    );
    all = all.concat(rows.map((r) => ({ ...rowToDTO(r, dataId), installed: (mine.get(r.id) ?? 0) >= Number(r.version) })));
  }
  let out = all;
  if (q.kind) out = out.filter((l) => l.kind === q.kind);
  if (q.category) out = out.filter((l) => (l.category ?? "other") === q.category);
  if (q.q) out = out.filter((l) => matchesQuery(l, q.q!));
  out = sortListings(out, q.sort);
  const limit = Math.min(Math.max(q.limit ?? 200, 1), 500);
  return out.slice(0, limit);
}

/** One listing if the caller may see it (public, own, or built-in). */
export async function getListing(dataId: string, id: string): Promise<ListingDTO | null> {
  if (isBuiltinId(id)) {
    const l = getBuiltinListing(id);
    if (!l) return null;
    if (!(await hasTables())) return l;
    const [mine, ratings, installs] = await Promise.all([installedIds(dataId), builtinRatings(), builtinInstallCounts()]);
    return annotateBuiltin(l, ratings, installs, mine);
  }
  if (!(await hasTables())) return null;
  const row = await queryOne<ListingRow>(`SELECT ${COLS} FROM marketplace_listings WHERE id = $1 AND ((visibility = 'public' AND published_at IS NOT NULL) OR user_id = $2)`, [id, dataId]);
  if (!row) return null;
  const mine = await installedIds(dataId);
  return { ...rowToDTO(row, dataId), installed: (mine.get(row.id) ?? 0) >= Number(row.version) };
}

export async function listMine(dataId: string): Promise<ListingDTO[]> {
  if (!(await hasTables())) return [];
  const rows = await query<ListingRow>(`SELECT ${COLS} FROM marketplace_listings WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 200`, [dataId]);
  return rows.map((r) => rowToDTO(r, dataId));
}

export interface PublishInput {
  kind: ListingKind;
  entityId: string;
  visibility?: Visibility;
  title?: string | null;
  summary?: string | null;
  description_md?: string | null;
  category?: string | null;
  tags?: string[] | null;
  slug?: string | null;
}

export interface PublishResult {
  listing: ListingDTO;
  /** Config keys dropped from an automation before publishing. */
  scrubbed: string[];
  /** True when an existing listing with the same slug was re-published as a new version. */
  updated: boolean;
}

/** Export an entity and create (or re-version) the org's listing for it. */
export async function publishListing(dataId: string, input: PublishInput): Promise<PublishResult> {
  if (!(await hasTables())) throw new Error("Marketplace tables are not installed yet (run aws/phase4/c.sql)");
  const exported = await exportAsListing(dataId, input.kind, input.entityId);
  const visibility: Visibility = input.visibility ?? "private";
  const slug = slugifyListing(input.slug?.trim() || exported.slug) || `listing-${randomUUID().slice(0, 8)}`;
  const title = input.title?.trim() || exported.title;
  const summary = input.summary?.trim() || exported.summary;
  const description_md = input.description_md?.trim() || exported.description_md;
  const category = input.category?.trim() || exported.category;
  const tags = (input.tags?.length ? input.tags : exported.tags).map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 12);
  const definition = JSON.stringify(exported.definition);

  const existing = await queryOne<{ id: string; version: number }>(`SELECT id, version FROM marketplace_listings WHERE user_id = $1 AND slug = $2`, [dataId, slug]);
  let id: string;
  if (existing) {
    id = existing.id;
    await query(
      `UPDATE marketplace_listings
          SET kind = $3, title = $4, summary = $5, description_md = $6, category = $7, tags = $8, definition = $9,
              version = version + 1, visibility = $10, updated_at = NOW(),
              published_at = CASE WHEN $10 = 'private' THEN published_at ELSE COALESCE(published_at, NOW()) END
        WHERE id = $1 AND user_id = $2`,
      [id, dataId, input.kind, title, summary, description_md, category, JSON.stringify(tags), definition, visibility]
    );
  } else {
    id = randomUUID();
    await query(
      `INSERT INTO marketplace_listings (id, user_id, kind, slug, title, summary, description_md, category, tags, definition, version, visibility, install_count, rating_sum, rating_count, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, $11, 0, 0, 0, $12)`,
      [id, dataId, input.kind, slug, title, summary, description_md, category, JSON.stringify(tags), definition, visibility, visibility === "private" ? null : new Date().toISOString()]
    );
  }
  const listing = await getListing(dataId, id);
  if (!listing) throw new Error("Listing vanished after publish");
  return { listing, scrubbed: exported.scrubbed, updated: Boolean(existing) };
}

export interface ListingPatch {
  title?: string;
  summary?: string | null;
  description_md?: string | null;
  category?: string | null;
  tags?: string[];
  visibility?: Visibility;
}

export async function updateListing(dataId: string, id: string, patch: ListingPatch): Promise<ListingDTO> {
  if (isBuiltinId(id)) throw new Error("Built-in listings cannot be edited");
  const sets: string[] = ["updated_at = NOW()"];
  const params: unknown[] = [id, dataId];
  const push = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.title !== undefined) push("title", patch.title.trim());
  if (patch.summary !== undefined) push("summary", patch.summary);
  if (patch.description_md !== undefined) push("description_md", patch.description_md);
  if (patch.category !== undefined) push("category", patch.category);
  if (patch.tags !== undefined) push("tags", JSON.stringify(patch.tags.map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 12)));
  if (patch.visibility !== undefined) {
    push("visibility", patch.visibility);
    if (patch.visibility !== "private") sets.push("published_at = COALESCE(published_at, NOW())");
  }
  const rows = await query<{ id: string }>(`UPDATE marketplace_listings SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2 RETURNING id`, params);
  if (rows.length === 0) throw new Error("Listing not found");
  const out = await getListing(dataId, id);
  if (!out) throw new Error("Listing not found");
  return out;
}

export async function deleteListing(dataId: string, id: string): Promise<boolean> {
  if (isBuiltinId(id)) throw new Error("Built-in listings cannot be deleted");
  const rows = await query<{ id: string }>(`DELETE FROM marketplace_listings WHERE id = $1 AND user_id = $2 RETURNING id`, [id, dataId]);
  if (rows.length === 0) return false;
  await query(`DELETE FROM marketplace_reviews WHERE listing_id = $1`, [id]).catch(() => undefined);
  return true;
}

/* ─── Reviews ────────────────────────────────────────────────────────────── */

interface ReviewRow {
  id: string;
  user_id: string;
  listing_id: string;
  rating: number;
  body: string | null;
  created_at: string;
}

export async function listReviews(dataId: string, listingId: string, limit = 50): Promise<ReviewDTO[]> {
  if (!(await hasTables())) return [];
  // Reviews inherit the listing's visibility: a private listing of another org must not leak its reviews (or its existence).
  if (!(await getListing(dataId, listingId))) return [];
  const rows = await query<ReviewRow>(`SELECT id, user_id, listing_id, rating, body, created_at FROM marketplace_reviews WHERE listing_id = $1 ORDER BY created_at DESC LIMIT $2`, [
    listingId,
    Math.min(Math.max(limit, 1), 200),
  ]);
  return rows.map((r) => ({ id: r.id, listing_id: r.listing_id, rating: Number(r.rating), body: r.body, mine: r.user_id === dataId, created_at: String(r.created_at) }));
}

async function recomputeRating(listingId: string): Promise<void> {
  if (isBuiltinId(listingId)) return;
  await query(
    `UPDATE marketplace_listings SET
        rating_sum = COALESCE((SELECT SUM(rating) FROM marketplace_reviews WHERE listing_id = $1), 0),
        rating_count = COALESCE((SELECT COUNT(*) FROM marketplace_reviews WHERE listing_id = $1), 0)
      WHERE id = $1`,
    [listingId]
  );
}

/** One review per org per listing; a second submission replaces the first. */
export async function addReview(dataId: string, listingId: string, rating: number, body: string | null): Promise<ReviewDTO> {
  if (!(await hasTables())) throw new Error("Marketplace tables are not installed yet (run aws/phase4/c.sql)");
  const listing = await getListing(dataId, listingId);
  if (!listing) throw new Error("Listing not found");
  if (listing.owner) throw new Error("You cannot review your own listing");
  const r = Math.round(rating);
  if (r < 1 || r > 5) throw new Error("Rating must be between 1 and 5");
  const clean = body?.trim().slice(0, 2000) || null;
  const existing = await queryOne<{ id: string }>(`SELECT id FROM marketplace_reviews WHERE user_id = $1 AND listing_id = $2`, [dataId, listingId]);
  let id: string;
  if (existing) {
    id = existing.id;
    await query(`UPDATE marketplace_reviews SET rating = $2, body = $3, created_at = NOW() WHERE id = $1`, [id, r, clean]);
  } else {
    id = randomUUID();
    await query(`INSERT INTO marketplace_reviews (id, user_id, listing_id, rating, body) VALUES ($1, $2, $3, $4, $5)`, [id, dataId, listingId, r, clean]);
  }
  await recomputeRating(listingId);
  return { id, listing_id: listingId, rating: r, body: clean, mine: true, created_at: new Date().toISOString() };
}

/** Validate that a listing's stored definition still parses (used before install). */
export function assertDefinition(listing: ListingDTO) {
  return parseDefinition(listing.kind, listing.definition);
}
