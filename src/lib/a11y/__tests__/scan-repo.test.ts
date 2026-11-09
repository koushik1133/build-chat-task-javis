import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fingerprint, scanSource } from "@/lib/a11y/scan";
import allow from "@/lib/a11y/allow.json";

const ROOT = process.cwd();
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx") && !p.includes("__tests__")) out.push(p);
  }
  return out;
}

describe("static a11y scan of the repo", () => {
  it("has no un-allowed high-confidence violations", () => {
    const allowed = new Set(Object.keys(allow.entries));
    const bad: string[] = [];
    for (const abs of [...walk(join(ROOT, "src/app")), ...walk(join(ROOT, "src/components"))]) {
      const file = relative(ROOT, abs);
      for (const f of scanSource(readFileSync(abs, "utf8"))) {
        if (f.severity !== "error") continue;
        if (allowed.has(fingerprint(file, f))) continue;
        bad.push(`${file}:${f.line} [${f.rule}] ${f.snippet}`);
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("keeps the allow-list small and justified", () => {
    const entries = Object.entries(allow.entries as Record<string, string>);
    expect(entries.length).toBeLessThanOrEqual(25);
    for (const [, reason] of entries) expect(reason.length).toBeGreaterThan(10);
  });
});
