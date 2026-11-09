import { describe, expect, it } from "vitest";
import { capResults, fuzzyStem, likePatterns, matchScore, normaliseKind, parseSearchQuery, rankItems } from "../rank";

describe("parseSearchQuery", () => {
  it("extracts kind: and in: only", () => {
    const p = parseSearchQuery("kind:orders customer:smith in:billing,crm john");
    expect(p.kinds).toEqual(["order"]);
    expect(p.areas).toEqual(["billing", "crm"]);
    expect(p.text).toBe("customer:smith john");
  });
  it("normalises plurals and aliases", () => {
    expect(normaliseKind("tickets")).toBe("ticket");
    expect(normaliseKind("bills")).toBe("bill");
    expect(normaliseKind("companies")).toBe("company");
  });
  it("handles plain text", () => {
    expect(parseSearchQuery("  hello  world ")).toEqual({ text: "hello world", kinds: [], areas: [] });
  });
});

describe("matchScore / ranking", () => {
  it("orders exact > prefix > word-start > substring > typo", () => {
    expect(matchScore("smith", "smith")).toBe(4);
    expect(matchScore("Smithson Ltd", "smith")).toBe(3);
    expect(matchScore("John Smith", "smith")).toBe(2);
    expect(matchScore("Blacksmith", "smith")).toBe(1);
    expect(matchScore("Smith", "smiht")).toBe(0.5);
    expect(matchScore("Jones", "smith")).toBe(0);
  });
  it("uses recency as the tiebreak", () => {
    const a = { kind: "x", id: "a", title: "Acme", subtitle: null, at: "2024-01-01T00:00:00Z" };
    const b = { kind: "x", id: "b", title: "Acme", subtitle: null, at: "2025-01-01T00:00:00Z" };
    const c = { kind: "x", id: "c", title: "Big Acme", subtitle: null, at: "2026-01-01T00:00:00Z" };
    expect(rankItems([a, c, b], "acme").map((i) => i.id)).toEqual(["b", "a", "c"]);
  });
  it("escapes like metacharacters and adds a stem", () => {
    expect(likePatterns("50%_off")[0]).toBe("%50\\%\\_off%");
    expect(likePatterns("smiht")).toEqual(["%smiht%", "%smi%"]);
    expect(fuzzyStem("abcd")).toBeNull();
  });
});

describe("capResults", () => {
  it("limits per kind and total", () => {
    const items = Array.from({ length: 60 }, (_, i) => ({ kind: `k${i % 3}`, id: String(i) }));
    const out = capResults(items);
    expect(out.length).toBe(15);
    expect(out.filter((x) => x.kind === "k0").length).toBe(5);
  });
});
