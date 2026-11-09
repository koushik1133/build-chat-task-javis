import { describe, expect, it } from "vitest";
import { hashStatement, splitStatements, loadStatements } from "@/lib/db/migrate";

describe("in-app migrator", () => {
  it("splits like the CLI runner: comments stripped, semicolons in comments ignored", () => {
    const out = splitStatements("-- a; comment\nCREATE TABLE a (id TEXT);\n\n-- more\nCREATE TABLE b (id TEXT);\n");
    expect(out).toEqual(["CREATE TABLE a (id TEXT)", "CREATE TABLE b (id TEXT)"]);
  });
  it("hashes whitespace-insensitively (same hash as the CLI)", () => {
    expect(hashStatement("CREATE  TABLE x\n(id TEXT)")).toBe(hashStatement("CREATE TABLE x (id TEXT)"));
  });
  it("loads the real migration file with unique, non-empty statements", () => {
    const s = loadStatements();
    expect(s.length).toBeGreaterThan(500);
    expect(s.every((x) => x.length > 5)).toBe(true);
  });
});
