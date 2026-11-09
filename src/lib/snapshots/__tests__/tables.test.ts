import { createHash } from "crypto";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { classifyTable, EXCLUDED_TABLES, EXPORT_TABLES, isDeniedColumn } from "../tables";
import { frameLine, manifestLine, projectRow } from "../tenant-export";

const AWS = join(process.cwd(), "aws");

/** Every aws/*.sql and aws/phase3..8/*.sql (phase9 lane files are folded into migrations.sql by the integrator). */
function sqlFiles(): string[] {
  const out = readdirSync(AWS).filter((f) => f.endsWith(".sql")).map((f) => join(AWS, f));
  for (let n = 3; n <= 8; n++) {
    const d = join(AWS, `phase${n}`);
    if (existsSync(d)) for (const f of readdirSync(d)) if (f.endsWith(".sql")) out.push(join(d, f));
  }
  return out;
}

function tablesWithUserId(): Set<string> {
  const found = new Set<string>();
  for (const f of sqlFiles()) {
    const sql = readFileSync(f, "utf8");
    const re = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n\);/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql))) if (/^\s*user_id\s/m.test(m[2])) found.add(m[1]);
    const alter = /ALTER TABLE\s+(\w+)\s+ADD COLUMN IF NOT EXISTS\s+user_id\b/g;
    while ((m = alter.exec(sql))) found.add(m[1]);
  }
  return found;
}

describe("tenant export table classification", () => {
  it("every table with a user_id column is allowed or explicitly excluded with a reason", () => {
    const unclassified = [...tablesWithUserId()].filter((t) => classifyTable(t) === "unclassified");
    expect(unclassified, `Classify these new tables in src/lib/snapshots/tables.ts: ${unclassified.join(", ")}`).toEqual([]);
  });

  it("no table is both exported and excluded; exclusions carry reasons", () => {
    for (const t of EXPORT_TABLES) expect(EXCLUDED_TABLES[t]).toBeUndefined();
    for (const [t, reason] of Object.entries(EXCLUDED_TABLES)) expect(reason.length, t).toBeGreaterThan(8);
  });

  it("credential tables are never exported", () => {
    for (const t of ["api_keys", "scim_tokens", "share_tokens", "user_integrations", "webhook_subscriptions", "mail_accounts", "social_accounts", "memberships"]) {
      expect(EXPORT_TABLES).not.toContain(t);
    }
  });

  it("denies secret-looking columns but keeps ordinary and usage-count columns", () => {
    for (const c of ["token_hash", "secret", "webhook_secret", "smtp_password_enc", "key_hash", "otp_hash", "session_token_hash", "password", "access_token", "refresh_token", "auth", "verification_token", "webhook_url_enc"]) expect(isDeniedColumn(c), c).toBe(true);
    for (const c of ["id", "user_id", "name", "tokens_in", "prompt_tokens", "created_at", "status", "otp_attempts"]) expect(isDeniedColumn(c), c).toBe(false);
  });
});

describe("NDJSON framing", () => {
  it("frames one JSON object per line and removes denied columns", () => {
    const line = frameLine({ table: "t", row: projectRow({ id: "1", name: "n", token_hash: "x", secret: "y", pdf_hash: "z" }) });
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1).includes("\n")).toBe(false);
    expect(JSON.parse(line)).toEqual({ table: "t", row: { id: "1", name: "n" } });
  });

  it("manifest carries counts, row total and the sha256 of preceding bytes", () => {
    const lines = [frameLine({ type: "header" }), frameLine({ table: "a", row: { id: "1" } }), frameLine({ table: "a", row: { id: "2" } })];
    const sha = createHash("sha256").update(lines.join("")).digest("hex");
    const m = JSON.parse(manifestLine({ counts: { a: 2 }, sha256: sha, complete: true, resume: null }));
    expect(m).toMatchObject({ type: "manifest", counts: { a: 2 }, rows: 2, sha256: sha, complete: true, resume: null });
  });
});
