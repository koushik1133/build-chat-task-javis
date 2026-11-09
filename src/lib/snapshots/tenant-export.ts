import { createHash, createHmac, timingSafeEqual } from "crypto";
import { query } from "@/lib/dsql";
import { columnsOfVia } from "@/lib/db/catalog";
import { EXPORT_TABLES, isDeniedColumn } from "./tables";

/**
 * Full tenant export (backup / portability) as NDJSON.
 *
 * Line 1:    {"type":"header", ...}
 * Rows:      {"table":"<name>","row":{...}}          (denylisted columns removed)
 * Last line: {"type":"manifest","counts":{...},"rows":N,"sha256":"<hex>","complete":bool,"resume":{table,after}|null}
 *
 * The sha256 covers every byte written BEFORE the manifest line. Tables come
 * from information_schema but only if they are in EXPORT_TABLES (tables.ts).
 * Rows are read 500 at a time with a keyset cursor on `id`; when the row or
 * time budget is hit the stream ends with `complete:false` and a `resume`
 * cursor so the client can continue with `?table=<t>&after=<id>`.
 */

export const BATCH_SIZE = 500;
/** Key-less tables (composite / user_id PKs) are read in one query; more rows than this are reported in the manifest, never silently dropped. */
export const KEYLESS_ROW_LIMIT = 10_000;
export const DEFAULT_ROW_BUDGET = 250_000;
export const DEFAULT_TIME_BUDGET_MS = 25_000;

export interface TableInfo {
  table: string;
  columns: string[]; // already filtered by the denylist
  hasId: boolean;
}

export function frameLine(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

export function projectRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!isDeniedColumn(k)) out[k] = v;
  return out;
}

function resumeSecret(): string {
  const k = process.env.CREDENTIAL_ENCRYPTION_KEY?.trim() || process.env.CRON_SECRET?.trim();
  if (k) return k;
  if (process.env.NODE_ENV === "production") throw new Error("Tenant export resume cursors need CREDENTIAL_ENCRYPTION_KEY (or CRON_SECRET).");
  return "tenant-export-dev-secret";
}

/** HMAC over (workspace, table, after): proves a resume cursor was issued by this server for this workspace. */
export function signResume(dataId: string, table: string, after: string | null): string {
  return createHmac("sha256", resumeSecret()).update(`${dataId}|${table}|${after ?? ""}`).digest("base64url");
}

export function verifyResume(dataId: string, table: string, after: string | null, sig: string | null | undefined): boolean {
  if (!sig) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(signResume(dataId, table, after));
  } catch {
    return false;
  }
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function manifestLine(args: { counts: Record<string, number>; sha256: string; complete: boolean; resume: { table: string; after: string | null; sig?: string } | null; truncated?: string[] }): string {
  const rows = Object.values(args.counts).reduce((a, b) => a + b, 0);
  return frameLine({ type: "manifest", counts: args.counts, rows, sha256: args.sha256, complete: args.complete, resume: args.resume, ...(args.truncated?.length ? { truncated: args.truncated } : {}) });
}

/** Tables present in the database AND allow-listed, sorted. Columns exclude the denylist. */
export async function discoverTables(): Promise<TableInfo[]> {
  const cols = await columnsOfVia((sql, params) => query(sql, params ?? []), [...EXPORT_TABLES]);
  const by = new Map<string, string[]>();
  for (const [table, names] of cols) {
    if (!names.includes("user_id")) continue; // only tenant-keyed tables are exported
    by.set(table, names.filter((c) => !isDeniedColumn(c)));
  }
  return [...by.entries()]
    .map(([table, columns]) => ({ table, columns, hasId: columns.includes("id") }))
    .sort((a, b) => a.table.localeCompare(b.table));
}

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

export interface TenantExportOptions {
  /** Resume from this table (inclusive) … */
  table?: string | null;
  /** … after this id (exclusive). */
  after?: string | null;
  rowBudget?: number;
  timeBudgetMs?: number;
}

export function tenantExportStream(dataId: string, opts: TenantExportOptions = {}): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const rowBudget = opts.rowBudget ?? DEFAULT_ROW_BUDGET;
  const deadline = Date.now() + (opts.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
  const hash = createHash("sha256");
  const counts: Record<string, number> = {};
  const truncated: string[] = [];
  let total = 0;
  let tables: TableInfo[] | null = null;
  let ti = 0;
  let after: string | null = opts.after ?? null;
  let started = false;
  let done = false;
  let enqueued = false;

  const write = (c: ReadableStreamDefaultController<Uint8Array>, line: string) => {
    enqueued = true;
    hash.update(line);
    c.enqueue(enc.encode(line));
  };
  const finish = (c: ReadableStreamDefaultController<Uint8Array>, resume: { table: string; after: string | null } | null) => {
    enqueued = true;
    const signed = resume ? { ...resume, sig: signResume(dataId, resume.table, resume.after) } : null;
    c.enqueue(enc.encode(manifestLine({ counts, sha256: hash.digest("hex"), complete: resume === null, resume: signed, truncated })));
    c.close();
    done = true;
  };

  return new ReadableStream<Uint8Array>({
    async pull(c) {
      // A pull that enqueues nothing is never retried by the stream, so keep stepping until a chunk is produced.
      enqueued = false;
      while (!done && !enqueued) await step(c);
    },
  });

  async function step(c: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    if (done) return;
    try {
      if (!started) {
        started = true;
        tables = await discoverTables();
        if (opts.table) {
          const idx = tables.findIndex((t) => t.table === opts.table);
          if (idx < 0) {
            write(c, frameLine({ type: "header", format: "kernelhub-tenant-export", version: 1, error: "unknown table" }));
            return finish(c, null);
          }
          ti = idx;
        }
        write(c, frameLine({ type: "header", format: "kernelhub-tenant-export", version: 1, generated_at: new Date().toISOString(), tables: tables.map((t) => t.table), resumed: Boolean(opts.table) }));
      }
      const list = tables ?? [];
      if (ti >= list.length) return finish(c, null);
      const t = list[ti];
      if (total >= rowBudget || Date.now() > deadline) return finish(c, { table: t.table, after });

      const cols = t.columns.map(q).join(", ");
      let rows: Record<string, unknown>[];
      if (t.hasId) {
        rows = await query<Record<string, unknown>>(
          `SELECT ${cols} FROM ${q(t.table)} WHERE user_id = $1 ${after !== null ? `AND id::text > $3` : ""} ORDER BY id::text LIMIT $2`,
          after !== null ? [dataId, BATCH_SIZE, after] : [dataId, BATCH_SIZE]
        );
      } else {
        // Key-less tables (counters, settings) are tiny: one read.
        rows = await query<Record<string, unknown>>(`SELECT ${cols} FROM ${q(t.table)} WHERE user_id = $1 LIMIT ${KEYLESS_ROW_LIMIT + 1}`, [dataId]);
        if (rows.length > KEYLESS_ROW_LIMIT) {
          truncated.push(t.table);
          rows = rows.slice(0, KEYLESS_ROW_LIMIT);
        }
      }
      for (const r of rows) write(c, frameLine({ table: t.table, row: projectRow(r) }));
      counts[t.table] = (counts[t.table] ?? 0) + rows.length;
      total += rows.length;
      if (t.hasId && rows.length === BATCH_SIZE) {
        after = String(rows[rows.length - 1].id);
      } else {
        ti++;
        after = null;
      }
    } catch (err) {
      console.error("[tenant-export] failed", err);
      c.error(err);
      done = true;
    }
  }
}
