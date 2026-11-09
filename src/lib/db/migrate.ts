import { readFileSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";
import { query } from "@/lib/dsql";

/**
 * In-app schema migrations (the same statements and hashes as scripts/run-migrations.mjs).
 *
 * Why this exists: the production database (Aurora DSQL) must carry every table the app
 * reads. On a hosted deployment there is often no shell with AWS credentials, so the app
 * can apply its own pending statements, a bounded batch at a time, through a protected
 * endpoint (/api/admin/migrate) or the worker tick (AUTO_MIGRATE=1).
 *
 * Statements run one at a time (DSQL allows one DDL per transaction); progress is recorded
 * per statement hash in `schema_migrations`, so every call resumes where the last stopped.
 */

const isLocalHost = () => {
  const h = process.env.DSQL_ENDPOINT;
  return h === "localhost" || h === "127.0.0.1";
};

/** Normalise whitespace so cosmetic edits don't re-run a statement (matches the CLI runner). */
const normalise = (stmt: string) => stmt.replace(/\s+/g, " ").trim();
export const hashStatement = (stmt: string) => createHash("sha256").update(normalise(stmt)).digest("hex");

/** Split the migration file exactly like the CLI runner does. */
export function splitStatements(sql: string): string[] {
  return sql
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface StatementEntry {
  sql: string;
  /** From the original base schema (aws/schema.sql). */
  base: boolean;
}

let cachedEntries: StatementEntry[] | null = null;
export function loadStatementEntries(): StatementEntry[] {
  if (cachedEntries) return cachedEntries;
  const read = (f: string) => splitStatements(readFileSync(join(process.cwd(), "aws", f), "utf8"));
  cachedEntries = [...read("schema.sql").map((sql) => ({ sql, base: true })), ...read("migrations.sql").map((sql) => ({ sql, base: false }))];
  return cachedEntries;
}

/** Table a base-schema CREATE INDEX statement targets, if it is one. */
export function baseIndexTable(sql: string): string | null {
  const m = /^CREATE\s+(?:UNIQUE\s+)?INDEX\b(?:\s+ASYNC)?(?!\s+IF\s+NOT\s+EXISTS)[\s\S]*?\bON\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?/i.exec(sql);
  return m ? m[1].toLowerCase() : null;
}

/** Tables the base schema creates (lower-case). */
export function baseTables(entries: StatementEntry[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (!e.base) continue;
    const m = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/i.exec(e.sql);
    if (m) out.push(m[1].toLowerCase());
  }
  return out;
}

let cached: string[] | null = null;
export function loadStatements(): string[] {
  if (cached) return cached;
  cached = loadStatementEntries().map((e) => e.sql);
  return cached;
}

async function ensureTable(): Promise<void> {
  await query("CREATE TABLE IF NOT EXISTS schema_migrations (hash TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())");
}

async function appliedHashes(): Promise<Set<string>> {
  const rows = await query<{ hash: string }>("SELECT hash FROM schema_migrations");
  return new Set(rows.map((r) => r.hash));
}

export interface MigrationStatus {
  total: number;
  applied: number;
  pending: number;
}

export async function migrationStatus(): Promise<MigrationStatus> {
  const statements = loadStatements();
  await ensureTable();
  const done = await appliedHashes();
  const pending = statements.filter((s) => !done.has(hashStatement(s))).length;
  return { total: statements.length, applied: statements.length - pending, pending };
}

async function awaitIndexJob(jobId: unknown, deadline: number): Promise<boolean> {
  if (!jobId) return true;
  while (Date.now() < deadline) {
    let row: { status?: string; details?: string } | undefined;
    try {
      row = (await query<{ status?: string; details?: string }>("SELECT status, details FROM sys.jobs WHERE job_id = $1", [jobId]))[0];
    } catch {
      return true; // cannot poll: do not block progress
    }
    const status = String(row?.status ?? "").toLowerCase();
    if (status === "completed") return true;
    if (status === "failed") throw new Error(`index job failed: ${row?.details ?? "no details"}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

export interface MigrationRun {
  applied: number;
  skipped: number;
  failed: Array<{ statement: string; error: string }>;
  remaining: number;
  total: number;
  budgetExhausted: boolean;
}

/**
 * Apply pending statements until the time budget runs out. Safe to call repeatedly and
 * concurrently-ish: "already exists" / "does not exist" errors are treated as applied,
 * exactly like the CLI runner.
 */
export async function runPendingMigrations(opts: { budgetMs?: number; maxFailures?: number } = {}): Promise<MigrationRun> {
  const budgetMs = Math.max(2000, opts.budgetMs ?? 40_000);
  const maxFailures = opts.maxFailures ?? 5;
  const deadline = Date.now() + budgetMs;
  const entries = loadStatementEntries();
  const statements = entries.map((e) => e.sql);
  await ensureTable();
  const done = await appliedHashes();

  // Base-schema indexes are unnamed (no IF NOT EXISTS). On a database whose base tables already
  // exist (an upgraded deployment) re-running them would create duplicate indexes, so they are
  // recorded as applied without running. A table that does not exist yet gets its indexes.
  const baseExisting = new Set<string>();
  const stillToRun = entries.some((e) => !done.has(hashStatement(e.sql)));
  if (stillToRun) {
    const { tableExists } = await import("@/lib/table-exists");
    for (const t of baseTables(entries)) if (await tableExists(t).catch(() => false)) baseExisting.add(t);
  }

  const out: MigrationRun = { applied: 0, skipped: 0, failed: [], remaining: 0, total: statements.length, budgetExhausted: false };
  const local = isLocalHost();

  for (let i = 0; i < statements.length; i++) {
    const raw = statements[i];
    const hash = hashStatement(raw);
    if (done.has(hash)) continue;
    if (entries[i].base) {
      const idxTable = baseIndexTable(raw);
      if (idxTable && baseExisting.has(idxTable)) {
        await query("INSERT INTO schema_migrations (hash) VALUES ($1) ON CONFLICT DO NOTHING", [hash]).catch(() => undefined);
        done.add(hash);
        out.skipped++;
        continue;
      }
    }
    if (Date.now() > deadline) {
      out.budgetExhausted = true;
      break;
    }
    const stmt = local ? raw.replace(/CREATE\s+(UNIQUE\s+)?INDEX\s+ASYNC/gi, "CREATE $1INDEX") : raw;
    const preview = normalise(stmt).slice(0, 90);
    try {
      const res = await query<{ job_id?: string }>(stmt);
      if (!local && /CREATE\s+(UNIQUE\s+)?INDEX\s+ASYNC/i.test(raw)) {
        const finished = await awaitIndexJob(res?.[0]?.job_id, deadline);
        if (!finished) {
          // Leave it pending; the next call re-issues it and "already exists" marks it applied.
          out.budgetExhausted = true;
          break;
        }
      }
      await query("INSERT INTO schema_migrations (hash) VALUES ($1) ON CONFLICT DO NOTHING", [hash]);
      done.add(hash);
      out.applied++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const cause = err && typeof err === "object" && "cause" in err ? String((err as { cause?: { message?: string } }).cause?.message ?? "") : "";
      const text = `${msg} ${cause}`;
      if (/already exists|does not exist/i.test(text)) {
        await query("INSERT INTO schema_migrations (hash) VALUES ($1) ON CONFLICT DO NOTHING", [hash]).catch(() => undefined);
        done.add(hash);
        out.skipped++;
      } else {
        out.failed.push({ statement: preview, error: text.trim().slice(0, 300) });
        if (out.failed.length >= maxFailures) break;
      }
    }
  }

  out.remaining = statements.filter((s) => !done.has(hashStatement(s))).length;
  return out;
}
