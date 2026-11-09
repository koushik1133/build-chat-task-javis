/**
 * Aurora DSQL compatibility rules — a pure, dependency-free rule engine.
 *
 * Production runs on Aurora DSQL (PostgreSQL-compatible, with documented
 * restrictions) while every local test runs on Postgres 17. These rules encode
 * the restrictions so a violation fails CI instead of failing in production.
 *
 * Rules marked `verify` reflect our best knowledge of the DSQL documentation
 * and must be re-checked against the current docs / a live cluster (see
 * docs/DSQL.md). They are errors where we prefer to stay conservative.
 */

export type Severity = "error" | "warning";
export type RuleScope = "ddl" | "source";

export interface Rule {
  id: string;
  name: string;
  severity: Severity;
  scope: RuleScope;
  /** Why DSQL rejects (or may reject) the construct. */
  rationale: string;
  /** What to do instead. */
  fix: string;
  /** True when the claim should be re-verified against current DSQL docs. */
  verify?: boolean;
  /** Matches against ONE normalised statement (ddl) or ONE line (source). */
  test: (text: string) => boolean;
}

export interface Finding {
  rule: string;
  name: string;
  severity: Severity;
  file: string;
  line: number;
  excerpt: string;
  rationale: string;
  fix: string;
}

export interface AllowEntry {
  rule: string;
  /** Path (substring) of the file. */
  file: string;
  /** Substring of the offending excerpt (stable across line shifts). */
  contains?: string;
  reason: string;
}

const ci = (re: RegExp, s: string) => re.test(s);
const isCreateIndex = (s: string) => /^CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(s);
const isAlterAddColumn = (s: string) => /^ALTER\s+TABLE\b.*\bADD\s+(COLUMN\b)?/i.test(s) && /\bADD\s+COLUMN\b/i.test(s);

export const RULES: Rule[] = [
  {
    id: "DSQL001", name: "foreign-key", severity: "error", scope: "ddl",
    rationale: "DSQL does not support FOREIGN KEY constraints.",
    fix: "Drop the REFERENCES clause; enforce referential integrity in application code.",
    test: (s) => /^(CREATE|ALTER)\s+TABLE\b/i.test(s) && /\bREFERENCES\b|\bFOREIGN\s+KEY\b/i.test(s),
  },
  {
    id: "DSQL002", name: "trigger", severity: "error", scope: "ddl",
    rationale: "DSQL does not support triggers.",
    fix: "Move the logic into application code (inside the same withRetry transaction).",
    test: (s) => ci(/^CREATE\s+(OR\s+REPLACE\s+)?(CONSTRAINT\s+)?TRIGGER\b/i, s),
  },
  {
    id: "DSQL003", name: "sequence-serial", severity: "error", scope: "ddl", verify: true,
    rationale: "DSQL does not support SERIAL / sequences (identity support is limited and differs).",
    fix: "Use TEXT PRIMARY KEY ids generated in code (randomUUID) or gen_random_uuid().",
    test: (s) => /^CREATE\s+(TEMP\w*\s+)?SEQUENCE\b/i.test(s) || /\b(BIG|SMALL)?SERIAL\b/i.test(s) || /\bGENERATED\b.*\bAS\s+IDENTITY\b/i.test(s),
  },
  {
    id: "DSQL004", name: "function-procedure", severity: "error", scope: "ddl", verify: true,
    rationale: "DSQL does not support PL/pgSQL; user-defined functions/procedures are unavailable or heavily limited.",
    fix: "Implement the logic in application code.",
    test: (s) => /^CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE)\b/i.test(s) || /\bLANGUAGE\s+plpgsql\b/i.test(s) || /^DO\s+\$/i.test(s),
  },
  {
    id: "DSQL005", name: "extension", severity: "error", scope: "ddl",
    rationale: "DSQL does not support CREATE EXTENSION (pg_trgm, uuid-ossp, pgcrypto, ...).",
    fix: "Use built-ins (gen_random_uuid()) or do the work in application code.",
    test: (s) => /^CREATE\s+EXTENSION\b/i.test(s),
  },
  {
    id: "DSQL006", name: "temp-table", severity: "error", scope: "ddl",
    rationale: "DSQL does not support temporary tables.",
    fix: "Use a CTE, a derived table, or an application-side collection.",
    test: (s) => /^CREATE\s+(GLOBAL\s+|LOCAL\s+)?(TEMP|TEMPORARY)\b/i.test(s),
  },
  {
    id: "DSQL007", name: "truncate", severity: "error", scope: "ddl",
    rationale: "DSQL does not support TRUNCATE.",
    fix: "Use batched DELETE (src/lib/db/batch.ts deleteInBatches).",
    test: (s) => /^TRUNCATE\b/i.test(s),
  },
  {
    id: "DSQL008", name: "index-not-async", severity: "error", scope: "ddl",
    rationale: "On DSQL, indexes on populated tables must be created with CREATE INDEX ASYNC (synchronous CREATE INDEX is only valid on empty tables).",
    fix: "Write `CREATE [UNIQUE] INDEX ASYNC IF NOT EXISTS ...` (the migration runner strips ASYNC on local Postgres).",
    test: (s) => isCreateIndex(s) && !/^CREATE\s+(UNIQUE\s+)?INDEX\s+ASYNC\b/i.test(s),
  },
  {
    id: "DSQL009", name: "partial-index", severity: "error", scope: "ddl", verify: true,
    rationale: "Partial indexes (CREATE INDEX ... WHERE ...) are not supported by DSQL.",
    fix: "Index a full column set; make uniqueness total by storing a deterministic key column (e.g. ref_key = COALESCE(provider_ref, id)).",
    test: (s) => isCreateIndex(s) && /\)\s*(INCLUDE\s*\([^)]*\)\s*)?WHERE\b/i.test(s),
  },
  {
    id: "DSQL010", name: "expression-index", severity: "warning", scope: "ddl", verify: true,
    rationale: "Expression indexes (e.g. lower(col)) may be unsupported on DSQL.",
    fix: "Index a stored normalised column instead.",
    test: (s) => {
      if (!isCreateIndex(s)) return false;
      const m = /\bON\s+\w+\s*(?:USING\s+\w+\s*)?\((.*)\)/is.exec(s);
      return !!m && /\w\s*\(/.test(m[1]);
    },
  },
  {
    id: "DSQL011", name: "add-column-constraint", severity: "error", scope: "ddl",
    rationale: "ALTER TABLE ... ADD COLUMN accepts only a name and a type on DSQL; DEFAULT / NOT NULL / REFERENCES / UNIQUE / CHECK / PRIMARY KEY are rejected.",
    fix: "ADD COLUMN IF NOT EXISTS x TYPE with no modifiers; set defaults and null handling in application code.",
    test: (s) => isAlterAddColumn(s) && /\b(DEFAULT|NOT\s+NULL|REFERENCES|UNIQUE|CHECK|PRIMARY\s+KEY|GENERATED)\b/i.test(s),
  },
  {
    id: "DSQL012", name: "alter-unsupported", severity: "error", scope: "ddl", verify: true,
    rationale: "DSQL supports only ADD COLUMN and RENAME in ALTER TABLE (no DROP COLUMN, ALTER COLUMN, ADD/DROP CONSTRAINT).",
    fix: "Add a new column and migrate in code; leave obsolete columns in place.",
    test: (s) => /^ALTER\s+TABLE\b/i.test(s) && /\b(DROP\s+(COLUMN|CONSTRAINT)|ALTER\s+(COLUMN\s+)?\w+\s+(TYPE|SET|DROP)|ADD\s+(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK))\b/i.test(s),
  },
  {
    id: "DSQL013", name: "multiple-statements", severity: "error", scope: "ddl",
    rationale: "DSQL allows one DDL statement per transaction and DDL cannot mix with DML; the runner executes one statement at a time.",
    fix: "Put each statement on its own, terminated by a semicolon, and never chain two on one line.",
    test: () => false, // evaluated structurally in lintDdl
  },
  {
    id: "DSQL014", name: "unsupported-column-type", severity: "error", scope: "ddl", verify: true,
    rationale: "json/jsonb, array, xml, money, inet/cidr and range types are not supported as column types on DSQL (they exist only as runtime types).",
    fix: "Store JSON as TEXT (JSON.stringify/parse in code) and arrays as JSON text.",
    test: (s) => (/^(CREATE\s+TABLE|ALTER\s+TABLE)\b/i.test(s)) && /(^|[\s,(])\w+\s+(JSONB?|XML|MONEY|INET|CIDR|MACADDR|TSVECTOR|TSQUERY|\w+RANGE)\b/i.test(s.replace(/\([^)]*\)/g, (m) => (/\bJSONB?\b/i.test(m) ? m : ""))) || (/^(CREATE\s+TABLE|ALTER\s+TABLE)\b/i.test(s) && /\b\w+\s+(TEXT|INTEGER|BIGINT|VARCHAR|BOOLEAN)\s*\[\s*\]/i.test(s)),
  },
  {
    id: "DSQL015", name: "unsupported-ddl-object", severity: "error", scope: "ddl", verify: true,
    rationale: "Materialized views, CREATE TYPE/DOMAIN, UNLOGGED/PARTITION/INHERITS/TABLESPACE, EXCLUDE constraints and rules are unsupported on DSQL.",
    fix: "Use plain tables / views and application logic.",
    test: (s) => /^CREATE\s+(MATERIALIZED\s+VIEW|TYPE|DOMAIN|RULE|UNLOGGED|COLLATION|TABLESPACE|PUBLICATION|SUBSCRIPTION)\b/i.test(s) || (/^CREATE\s+TABLE\b/i.test(s) && /\b(PARTITION\s+BY|INHERITS|TABLESPACE|EXCLUDE\s+USING)\b/i.test(s)),
  },
  {
    id: "DSQL016", name: "bulk-dml-in-migration", severity: "warning", scope: "ddl",
    rationale: "A single transaction may modify at most 3,000 rows (and ~10 MiB); a data UPDATE/DELETE inside a migration can exceed it on a large table.",
    fix: "Keep migrations schema-only; backfill lazily in code or in batches of <= 1000 rows (src/lib/db/batch.ts).",
    test: (s) => /^(UPDATE|DELETE\s+FROM)\b/i.test(s),
  },
  {
    id: "DSQL017", name: "comment-on", severity: "warning", scope: "ddl", verify: true,
    rationale: "COMMENT ON may be unsupported on DSQL.",
    fix: "Use SQL comments (-- ...) in the migration file instead.",
    test: (s) => /^COMMENT\s+ON\b/i.test(s),
  },
  // ── source (DML) rules ────────────────────────────────────────────────────
  {
    id: "DSQLS01", name: "truncate-dml", severity: "error", scope: "source",
    rationale: "TRUNCATE is unsupported on DSQL.",
    fix: "Use deleteInBatches() from src/lib/db/batch.ts.",
    test: (l) => /["'`]\s*TRUNCATE\s+(TABLE\s+)?\w|\bTRUNCATE\s+TABLE\s+\w/.test(l),
  },
  {
    id: "DSQLS02", name: "select-for-update", severity: "warning", scope: "source", verify: true,
    rationale: "FOR UPDATE exists on DSQL but under optimistic concurrency it is a conflict-detection hint, not a lock; SKIP LOCKED / NOWAIT semantics are unavailable.",
    fix: "Use an atomic conditional UPDATE ... WHERE status = 'x' RETURNING (claim pattern) inside withRetry.",
    test: (l) => /\bFOR\s+(NO\s+KEY\s+)?UPDATE\b|\bSKIP\s+LOCKED\b/i.test(l) && /SELECT|FROM|["'`]/i.test(l),
  },
  {
    id: "DSQLS03", name: "advisory-lock", severity: "error", scope: "source",
    rationale: "Advisory locks (pg_advisory_*) are not supported on DSQL.",
    fix: "Use a conditional UPDATE / INSERT on a lease row (see src/lib/system/state.ts) inside withRetry.",
    test: (l) => /\bpg_(try_)?advisory_/i.test(l),
  },
  {
    id: "DSQLS04", name: "listen-notify", severity: "error", scope: "source",
    rationale: "LISTEN/NOTIFY is not supported on DSQL.",
    fix: "Poll, or use the notification outbox.",
    test: (l) => /["'`]\s*(LISTEN|NOTIFY|UNLISTEN)\s+\w|\bpg_notify\s*\(/.test(l),
  },
  {
    id: "DSQLS05", name: "temp-table-dml", severity: "error", scope: "source",
    rationale: "Temporary tables are not supported on DSQL.",
    fix: "Use a CTE or application-side collection.",
    test: (l) => /\bCREATE\s+(GLOBAL\s+|LOCAL\s+)?(TEMP|TEMPORARY)\s+TABLE\b/i.test(l),
  },
  {
    id: "DSQLS06", name: "sequence-dml", severity: "error", scope: "source",
    rationale: "Sequences/SERIAL (nextval, currval, CREATE SEQUENCE) are not supported.",
    fix: "Generate ids in code; for human numbers use an atomic counter row (UPDATE ... RETURNING).",
    test: (l) => /\b(nextval|currval|setval)\s*\(/i.test(l) || /\bCREATE\s+SEQUENCE\b/.test(l),
  },
  {
    id: "DSQLS07", name: "ddl-in-source", severity: "error", scope: "source",
    rationale: "Runtime DDL (triggers, extensions, functions, FOREIGN KEY) is unsupported and DDL must not mix with DML in a transaction.",
    fix: "Put schema changes in aws/phase*/*.sql.",
    test: (l) => /["'`]\s*(CREATE\s+(OR\s+REPLACE\s+)?(TRIGGER|FUNCTION|EXTENSION)|ALTER\s+TABLE\b.*\bFOREIGN\s+KEY)/i.test(l),
  },
  {
    id: "DSQLS08", name: "ordered-set-aggregate", severity: "warning", scope: "source", verify: true,
    rationale: "percentile_cont / percentile_disc / mode() WITHIN GROUP availability on DSQL is not confirmed.",
    fix: "Compute the percentile in JS from fetched rows when the query errors (see src/lib/vitals.ts).",
    test: (l) => /\bpercentile_(cont|disc)\s*\(|\bWITHIN\s+GROUP\b/i.test(l),
  },
  {
    id: "DSQLS09", name: "information-schema", severity: "warning", scope: "source", verify: true,
    rationale: "information_schema exposes only a subset on DSQL.",
    fix: "Use src/lib/db/catalog.ts (information_schema first, to_regclass / pg_catalog fallback).",
    test: (l) => /\binformation_schema\./i.test(l),
  },
  {
    id: "DSQLS10", name: "jsonb-cast", severity: "warning", scope: "source", verify: true,
    rationale: "jsonb is a runtime-only type on DSQL; casts/operators on TEXT columns may behave differently from Postgres 17.",
    fix: "Prefer ::json with a text-parse fallback, or parse JSON in application code.",
    test: (l) => /::jsonb\b|\bjsonb_\w+\s*\(/i.test(l),
  },
  {
    id: "DSQLS11", name: "bulk-limit-over-1000", severity: "warning", scope: "source",
    rationale: "A transaction may modify at most 3,000 rows; large LIMITs on UPDATE/DELETE subselects risk that cap.",
    fix: "Use deleteInBatches() / inBatches() with size <= 1000.",
    test: (l) => /\b(DELETE|UPDATE)\b/i.test(l) && /\bLIMIT\s+(\d{4,})\b/i.test(l) && Number(/\bLIMIT\s+(\d{4,})\b/i.exec(l)?.[1] ?? 0) > 1000,
  },
];

export const RULES_BY_ID: Record<string, Rule> = Object.fromEntries(RULES.map((r) => [r.id, r]));

// ── statement splitting ─────────────────────────────────────────────────────

export interface Statement {
  text: string;
  /** 1-based line of the first non-space character. */
  line: number;
}

/** Strip `--` comments (outside quotes) while preserving newlines, then split on `;`. */
export function splitStatements(sql: string): Statement[] {
  const out: Statement[] = [];
  let cur = "";
  let line = 1;
  let startLine = 0;
  let quote: string | null = null;
  let dollar = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const n = sql[i + 1];
    if (!quote && !dollar && c === "-" && n === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      i--;
      continue;
    }
    if (!quote && c === "$" && n === "$") { dollar = !dollar; cur += "$$"; i++; continue; }
    if (!dollar && (c === "'" || c === '"')) {
      if (quote === c) quote = null; else if (!quote) quote = c;
    }
    if (c === ";" && !quote && !dollar) {
      if (cur.trim()) out.push({ text: cur.replace(/\s+/g, " ").trim(), line: startLine });
      cur = "";
      startLine = 0;
    } else {
      if (!startLine && !/\s/.test(c)) startLine = line;
      cur += c;
    }
    if (c === "\n") line++;
  }
  if (cur.trim()) out.push({ text: cur.replace(/\s+/g, " ").trim(), line: startLine || line });
  return out;
}

const toFinding = (r: Rule, file: string, line: number, excerpt: string): Finding => ({
  rule: r.id, name: r.name, severity: r.severity, file, line,
  excerpt: excerpt.length > 140 ? excerpt.slice(0, 137) + "..." : excerpt,
  rationale: r.rationale + (r.verify ? " (verify against current DSQL docs)" : ""),
  fix: r.fix,
});

/** Lint a SQL migration file's contents. */
export function lintDdl(file: string, sql: string): Finding[] {
  const findings: Finding[] = [];
  const rules = RULES.filter((r) => r.scope === "ddl");
  for (const st of splitStatements(sql)) {
    for (const r of rules) if (r.test(st.text)) findings.push(toFinding(r, file, st.line, st.text));
    // Structural: two DDL verbs in one statement body (a missing semicolon).
    const verbs = st.text.match(/(^|\s)(CREATE\s+(UNIQUE\s+)?(TABLE|INDEX)|ALTER\s+TABLE|DROP\s+(TABLE|INDEX))\s/gi) ?? [];
    if (verbs.length > 1) findings.push(toFinding(RULES_BY_ID.DSQL013, file, st.line, st.text));
  }
  // Two terminated statements on one physical line.
  const lines = sql.split("\n");
  lines.forEach((raw, i) => {
    const l = raw.replace(/--.*$/, "").replace(/'[^']*'/g, "''");
    if ((l.match(/;/g) ?? []).length > 1) findings.push(toFinding(RULES_BY_ID.DSQL013, file, i + 1, raw.trim()));
  });
  return findings;
}

/** Lint TypeScript source for risky SQL patterns, line by line. */
export function lintSource(file: string, ts: string): Finding[] {
  const findings: Finding[] = [];
  const rules = RULES.filter((r) => r.scope === "source");
  ts.split("\n").forEach((raw, i) => {
    const t = raw.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
    for (const r of rules) if (r.test(raw)) findings.push(toFinding(r, file, i + 1, t));
  });
  return findings;
}

/** Split findings into reported vs allow-listed. Every allow entry must carry a reason. */
export function applyAllowList(findings: Finding[], allow: AllowEntry[]): { reported: Finding[]; allowed: Finding[]; badEntries: AllowEntry[] } {
  const badEntries = allow.filter((a) => !a.reason || a.reason.trim().length < 10);
  const reported: Finding[] = [];
  const allowed: Finding[] = [];
  for (const f of findings) {
    const hit = allow.some((a) => a.reason && a.rule === f.rule && f.file.includes(a.file) && (!a.contains || f.excerpt.includes(a.contains)));
    (hit ? allowed : reported).push(f);
  }
  return { reported, allowed, badEntries };
}

export function formatFinding(f: Finding): string {
  return `${f.severity.toUpperCase().padEnd(7)} ${f.rule} ${f.name}  ${f.file}:${f.line}\n    ${f.excerpt}\n    why: ${f.rationale}\n    fix: ${f.fix}`;
}
