import { randomUUID } from "crypto";
import { query } from "@/lib/dsql";
import { FAVORITES_CAP, RECENT_CAP, favoriteKey, idsToPrune } from "./pure";

export interface RecentRow {
  id: string;
  kind: string;
  entity_id: string;
  title: string;
  href: string;
  opened_at: string;
}

export interface FavoriteRow {
  id: string;
  kind: string;
  entity_id: string | null;
  label: string;
  href: string;
  sort: number;
  created_at: string;
}

export async function recordRecent(
  dataId: string,
  member: string,
  item: { kind: string; entityId: string; title: string; href: string }
): Promise<void> {
  const update = () =>
    query<{ id: string }>(
      `UPDATE recent_items SET title = $5, href = $6, opened_at = NOW()
        WHERE user_id = $1 AND member_user_id = $2 AND kind = $3 AND entity_id = $4 RETURNING id`,
      [dataId, member, item.kind, item.entityId, item.title, item.href]
    );
  const hit = await update();
  if (hit.length === 0) {
    try {
      await query(
        `INSERT INTO recent_items (id, user_id, member_user_id, kind, entity_id, title, href) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [randomUUID(), dataId, member, item.kind, item.entityId, item.title, item.href]
      );
    } catch {
      await update(); // concurrent insert won the unique index
    }
  }
  await pruneRecents(dataId, member);
}

export async function pruneRecents(dataId: string, member: string): Promise<number> {
  const rows = await query<{ id: string; opened_at: string }>(
    `SELECT id, opened_at FROM recent_items WHERE user_id = $1 AND member_user_id = $2 ORDER BY opened_at DESC LIMIT ${RECENT_CAP + 50}`,
    [dataId, member]
  );
  const drop = idsToPrune(rows, RECENT_CAP);
  if (drop.length) await query(`DELETE FROM recent_items WHERE user_id = $1 AND member_user_id = $2 AND id = ANY($3)`, [dataId, member, drop]);
  return drop.length;
}

export async function listRecents(dataId: string, member: string, limit = 8): Promise<RecentRow[]> {
  return query<RecentRow>(
    `SELECT id, kind, entity_id, title, href, opened_at FROM recent_items
      WHERE user_id = $1 AND member_user_id = $2 ORDER BY opened_at DESC LIMIT $3`,
    [dataId, member, Math.max(1, Math.min(RECENT_CAP, limit))]
  );
}

export async function listFavorites(dataId: string, member: string): Promise<FavoriteRow[]> {
  return query<FavoriteRow>(
    `SELECT id, kind, entity_id, label, href, sort, created_at FROM favorites
      WHERE user_id = $1 AND member_user_id = $2 ORDER BY sort ASC, created_at ASC LIMIT ${FAVORITES_CAP}`,
    [dataId, member]
  );
}

/** Idempotent add: returns the existing row when the same entity/page is already pinned. */
export async function addFavorite(
  dataId: string,
  member: string,
  fav: { kind: string; entityId: string | null; label: string; href: string }
): Promise<{ row: FavoriteRow; created: boolean } | { error: "limit" }> {
  const existing = await listFavorites(dataId, member);
  const key = favoriteKey(fav.kind, fav.entityId, fav.href);
  const dup = existing.find((f) => favoriteKey(f.kind, f.entity_id, f.href) === key);
  if (dup) return { row: dup, created: false };
  if (existing.length >= FAVORITES_CAP) return { error: "limit" };
  const id = randomUUID();
  const sort = existing.length ? Math.max(...existing.map((f) => Number(f.sort) || 0)) + 1 : 0;
  const rows = await query<FavoriteRow>(
    `INSERT INTO favorites (id, user_id, member_user_id, kind, entity_id, label, href, sort)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, kind, entity_id, label, href, sort, created_at`,
    [id, dataId, member, fav.kind, fav.entityId, fav.label, fav.href, sort]
  );
  return { row: rows[0], created: true };
}

export async function removeFavorite(dataId: string, member: string, id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `DELETE FROM favorites WHERE user_id = $1 AND member_user_id = $2 AND id = $3 RETURNING id`,
    [dataId, member, id]
  );
  return rows.length > 0;
}
