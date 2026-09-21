import { query } from "@/lib/dsql";

/**
 * Soft delete: rows get `deleted_at = NOW()` instead of being removed, so
 * they can be restored and remain in audit history.
 *
 * Only tables listed here carry a `deleted_at` column (see aws/migrations.sql,
 * "PHASE 2 LANE B"). Table names are validated against this list so callers
 * can never interpolate arbitrary SQL.
 */
export const SOFT_DELETE_TABLES = ["crm_contacts", "tasks", "production_tasks", "sites", "agents"] as const;
export type SoftDeleteTable = (typeof SOFT_DELETE_TABLES)[number];

export function isSoftDeleteTable(t: string): t is SoftDeleteTable {
  return (SOFT_DELETE_TABLES as readonly string[]).includes(t);
}

function assertTable(table: string): SoftDeleteTable {
  if (!isSoftDeleteTable(table)) throw new Error(`soft delete not supported for table "${table}"`);
  return table;
}

/** Mark a row deleted. Returns true when a live row was affected. */
export async function softDelete(table: SoftDeleteTable, id: string, dataId: string): Promise<boolean> {
  const t = assertTable(table);
  const rows = await query<{ id: string }>(
    `UPDATE ${t} SET deleted_at = NOW() WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING id`,
    [id, dataId]
  );
  return rows.length > 0;
}

/** Undo a soft delete. Returns true when a deleted row was affected. */
export async function restore(table: SoftDeleteTable, id: string, dataId: string): Promise<boolean> {
  const t = assertTable(table);
  const rows = await query<{ id: string }>(
    `UPDATE ${t} SET deleted_at = NULL WHERE id = $1 AND user_id = $2 AND deleted_at IS NOT NULL RETURNING id`,
    [id, dataId]
  );
  return rows.length > 0;
}

/** SQL fragment for list queries: `AND deleted_at IS NULL` (optionally aliased). */
export function notDeleted(alias?: string): string {
  return `${alias ? `${alias}.` : ""}deleted_at IS NULL`;
}
