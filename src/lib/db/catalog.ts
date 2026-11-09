/**
 * Catalog introspection that survives Aurora DSQL's limited `information_schema`.
 *
 * Strategy (each step only runs when the previous one errored or found nothing):
 *   1. information_schema            — portable, fully available on Postgres
 *   2. to_regclass('public.<name>')  — cheap existence probe
 *   3. pg_catalog.pg_tables / pg_attribute — system catalogs
 * All functions take an injectable query function so they are unit-testable
 * and independent of `@/lib/dsql` (safe to import from anywhere server-side).
 */

export type CatalogQuery = (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;

const IDENT = /^[a-z_][a-z0-9_]*$/;

/** Does `public.<name>` exist? Never throws; false when every probe fails. */
export async function tableExistsVia(q: CatalogQuery, name: string): Promise<boolean> {
  if (!IDENT.test(name)) return false;
  try {
    const rows = await q(
      `SELECT table_name AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1 LIMIT 1`,
      [name]
    );
    if (rows.length > 0) return true;
  } catch {
    /* information_schema unavailable or restricted: fall through */
  }
  try {
    const rows = await q(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${name}`]);
    const ok = rows[0]?.ok;
    if (ok === true || ok === "t" || ok === "true") return true;
  } catch {
    /* to_regclass unavailable: fall through */
  }
  try {
    const rows = await q(`SELECT tablename AS n FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename = $1 LIMIT 1`, [name]);
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Column names (in ordinal order) for each of `tables` that exists in `public`.
 * Tables with no visible columns are omitted. Throws only if every source fails.
 */
export async function columnsOfVia(q: CatalogQuery, tables: readonly string[]): Promise<Map<string, string[]>> {
  const names = tables.filter((t) => IDENT.test(t));
  const out = new Map<string, string[]>();
  if (names.length === 0) return out;
  const collect = (rows: Array<Record<string, unknown>>) => {
    for (const r of rows) {
      const t = String(r.table_name);
      const list = out.get(t) ?? [];
      list.push(String(r.column_name));
      out.set(t, list);
    }
  };
  let firstErr: unknown = null;
  try {
    collect(
      await q(
        `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1::text[]) ORDER BY table_name, ordinal_position`,
        [names]
      )
    );
    if (out.size > 0) return out;
  } catch (err) {
    firstErr = err;
  }
  try {
    collect(
      await q(
        `SELECT c.relname AS table_name, a.attname AS column_name
           FROM pg_catalog.pg_attribute a
           JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped AND c.relname = ANY($1::text[])
          ORDER BY c.relname, a.attnum`,
        [names]
      )
    );
  } catch (err) {
    if (firstErr) throw err;
  }
  return out;
}

/** Table names in `public` among `candidates` (existence only), memo-friendly bulk probe. */
export async function existingTablesVia(q: CatalogQuery, candidates: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const name of candidates) if (await tableExistsVia(q, name)) found.add(name);
  return found;
}
