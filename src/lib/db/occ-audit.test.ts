import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Aurora DSQL uses optimistic concurrency: any transaction can fail with 40001 / OC000 / OC001 at COMMIT
 * and must be retried from the start. Every `transaction(` call site must therefore sit inside `withRetry(`
 * (or be explicitly allow-listed below with a reason).
 */
const ROOT = join(__dirname, "../../..");
const ALLOW: Array<{ file: string; reason: string }> = [];

function walk(dir: string, acc: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) {
      if (n !== "node_modules" && n !== "__tests__" && n !== "__integration__") walk(p, acc);
    } else if (/\.(ts|tsx)$/.test(n) && !/\.test\./.test(n)) acc.push(p);
  }
  return acc;
}

describe("OCC coverage", () => {
  const sites: Array<{ file: string; line: number; wrapped: boolean }> = [];
  for (const f of walk(join(ROOT, "src"))) {
    const rel = relative(ROOT, f);
    if (rel === "src/lib/dsql.ts") continue; // the definition
    const lines = readFileSync(f, "utf8").split("\n");
    lines.forEach((l, i) => {
      if (/^\s*(\/\/|\*)/.test(l)) return;
      if (/\btransaction\s*\(\s*(async\b|\(|\w+\s*=>)/.test(l) && /import|=|await|\(/.test(l)) {
        // Wrapped when withRetry( appears on this line or within the 3 preceding lines.
        const ctx = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
        sites.push({ file: rel, line: i + 1, wrapped: /withRetry\s*\(/.test(ctx) });
      }
      if (/["'`]\s*BEGIN\s*["'`;]/.test(l)) sites.push({ file: rel, line: i + 1, wrapped: false });
    });
  }

  it("finds the transaction call sites", () => {
    expect(sites.length).toBeGreaterThan(0);
  });

  it("wraps every transaction() call in withRetry (or allow-lists it with a reason)", () => {
    const bad = sites.filter((s) => !s.wrapped && !ALLOW.some((a) => a.file === s.file));
    expect(bad.map((s) => `${s.file}:${s.line}`)).toEqual([]);
    for (const a of ALLOW) expect(a.reason.length).toBeGreaterThan(10);
  });
});
