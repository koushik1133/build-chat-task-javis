import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { applyAllowList, lintDdl, lintSource, splitStatements, type AllowEntry } from "../rules";

const ids = (sql: string) => lintDdl("t.sql", sql).map((f) => f.rule);

describe("dsql-compat DDL rules", () => {
  it("accepts the canonical DSQL-safe forms", () => {
    expect(ids(`CREATE TABLE IF NOT EXISTS a (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, data TEXT, n BIGINT, at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE INDEX ASYNC IF NOT EXISTS i ON a (user_id, at);
      CREATE UNIQUE INDEX ASYNC IF NOT EXISTS u ON a (user_id, id);
      ALTER TABLE a ADD COLUMN IF NOT EXISTS x TEXT;`)).toEqual([]);
  });
  it.each([
    ["DSQL001", "CREATE TABLE b (id TEXT PRIMARY KEY, a TEXT REFERENCES a(id));"],
    ["DSQL001", "CREATE TABLE b (id TEXT, FOREIGN KEY (id) REFERENCES a(id));"],
    ["DSQL002", "CREATE TRIGGER t BEFORE INSERT ON a FOR EACH ROW EXECUTE FUNCTION f();"],
    ["DSQL003", "CREATE SEQUENCE s;"],
    ["DSQL003", "CREATE TABLE b (id SERIAL PRIMARY KEY);"],
    ["DSQL004", "CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;"],
    ["DSQL005", "CREATE EXTENSION pg_trgm;"],
    ["DSQL006", "CREATE TEMP TABLE t (id TEXT);"],
    ["DSQL007", "TRUNCATE a;"],
    ["DSQL008", "CREATE INDEX IF NOT EXISTS i ON a (x);"],
    ["DSQL008", "CREATE UNIQUE INDEX i ON a (x);"],
    ["DSQL009", "CREATE UNIQUE INDEX ASYNC IF NOT EXISTS u ON a (x) WHERE x IS NOT NULL;"],
    ["DSQL010", "CREATE INDEX ASYNC IF NOT EXISTS i ON a (lower(x));"],
    ["DSQL011", "ALTER TABLE a ADD COLUMN IF NOT EXISTS x TEXT DEFAULT 'y';"],
    ["DSQL011", "ALTER TABLE a ADD COLUMN x TEXT NOT NULL;"],
    ["DSQL012", "ALTER TABLE a DROP COLUMN x;"],
    ["DSQL012", "ALTER TABLE a ADD CONSTRAINT c CHECK (x > 0);"],
    ["DSQL013", "CREATE TABLE a (id TEXT); CREATE TABLE b (id TEXT);"],
    ["DSQL014", "CREATE TABLE a (id TEXT, d JSONB);"],
    ["DSQL014", "CREATE TABLE a (id TEXT, tags TEXT[]);"],
    ["DSQL015", "CREATE MATERIALIZED VIEW v AS SELECT 1;"],
    ["DSQL016", "UPDATE a SET x = 1 WHERE x IS NULL;"],
  ])("%s flags %s", (rule, sql) => {
    expect(ids(sql)).toContain(rule);
  });

  it("reports the line number of the statement and strips comments", () => {
    const f = lintDdl("t.sql", "-- hi; TRUNCATE x;\n\n\nTRUNCATE a;");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule: "DSQL007", line: 4, severity: "error" });
    expect(f[0].fix.length).toBeGreaterThan(5);
    expect(f[0].rationale.length).toBeGreaterThan(5);
  });
  it("does not split on semicolons inside string literals", () => {
    expect(splitStatements("INSERT INTO a VALUES ('x;y'); SELECT 1;")).toHaveLength(2);
  });
});

describe("dsql-compat source rules", () => {
  const src = (line: string) => lintSource("x.ts", line).map((f) => f.rule);
  it("flags risky SQL in source but ignores comments and prose", () => {
    expect(src("await query(`TRUNCATE TABLE foo`)")).toContain("DSQLS01");
    expect(src("SELECT 1 FOR UPDATE SKIP LOCKED")).toContain("DSQLS02");
    expect(src("SELECT pg_advisory_lock(1)")).toContain("DSQLS03");
    expect(src("await query('LISTEN chan')")).toContain("DSQLS04");
    expect(src("SELECT nextval('s')")).toContain("DSQLS06");
    expect(src("// TRUNCATE TABLE foo")).toEqual([]);
    expect(src("return fail(`Notify failed: x`)")).toEqual([]);
    expect(src("DELETE FROM a WHERE id IN (SELECT id FROM a LIMIT 5000)")).toContain("DSQLS11");
  });
});

describe("allow list", () => {
  it("requires a reason and matches by rule + file + excerpt", () => {
    const findings = lintDdl("aws/x.sql", "CREATE INDEX i ON a (x);");
    const ok: AllowEntry[] = [{ rule: "DSQL008", file: "aws/x.sql", contains: "INDEX i", reason: "legacy statement superseded by phase10" }];
    expect(applyAllowList(findings, ok).reported).toHaveLength(0);
    const bad: AllowEntry[] = [{ rule: "DSQL008", file: "aws/x.sql", reason: "" }];
    const r = applyAllowList(findings, bad);
    expect(r.reported).toHaveLength(1);
    expect(r.badEntries).toHaveLength(1);
  });
});

describe("repository migrations", () => {
  const root = join(__dirname, "../../../..");
  const sqlFiles = [join(root, "aws/migrations.sql")];
  for (const d of readdirSync(join(root, "aws")).filter((x) => /^phase\d+$/.test(x)).sort()) {
    for (const f of readdirSync(join(root, "aws", d)).filter((x) => x.endsWith(".sql")).sort()) sqlFiles.push(join(root, "aws", d, f));
  }
  const allow: AllowEntry[] = JSON.parse(readFileSync(join(root, "scripts/dsql-lint.allow.json"), "utf8"));

  it("has zero un-allowed DSQL errors across aws/migrations.sql and aws/phase*/*.sql", () => {
    const findings = sqlFiles.flatMap((f) => lintDdl(f.slice(root.length + 1), readFileSync(f, "utf8")));
    const { reported, badEntries } = applyAllowList(findings, allow);
    expect(badEntries).toEqual([]);
    expect(reported.filter((f) => f.severity === "error").map((f) => `${f.rule} ${f.file}:${f.line}`)).toEqual([]);
  });

  it("every allow-list entry carries a real reason and still matches something", () => {
    const findings = sqlFiles.flatMap((f) => lintDdl(f.slice(root.length + 1), readFileSync(f, "utf8")));
    for (const a of allow) {
      expect(a.reason.trim().length).toBeGreaterThanOrEqual(20);
      if (a.rule.startsWith("DSQLS")) continue; // source rules are checked by the CLI
      expect(findings.some((f) => f.rule === a.rule && f.file.includes(a.file) && (!a.contains || f.excerpt.includes(a.contains))), `stale allow entry ${a.rule} ${a.file}`).toBe(true);
    }
  });

  it("phase10 corrections exist and use ASYNC", () => {
    const p = join(root, "aws/phase10/a.sql");
    expect(existsSync(p)).toBe(true);
    const sql = readFileSync(p, "utf8");
    expect(sql).toMatch(/CREATE UNIQUE INDEX ASYNC IF NOT EXISTS uq_invoice_payments_ref_key/);
    expect(sql).toMatch(/DROP INDEX IF EXISTS uq_invoice_payments_provider_ref/);
  });
});
