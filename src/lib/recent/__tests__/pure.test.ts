import { describe, expect, it } from "vitest";
import { favoriteKey, idsToPrune, safeHref } from "../pure";

describe("recent pure helpers", () => {
  it("prunes everything beyond the cap, keeping the newest", () => {
    const rows = Array.from({ length: 35 }, (_, i) => ({ id: `r${i}`, opened_at: new Date(2026, 0, 1, 0, i).toISOString() }));
    const drop = idsToPrune(rows, 30);
    expect(drop).toHaveLength(5);
    expect(drop).toEqual(["r4", "r3", "r2", "r1", "r0"]);
    expect(idsToPrune(rows.slice(0, 10), 30)).toEqual([]);
  });
  it("favourite keys are unique per entity or page href", () => {
    expect(favoriteKey("order", "o1", "/orders?order=o1")).toBe("order:o1");
    expect(favoriteKey("page", null, "/crm")).toBe("page:/crm");
    expect(favoriteKey("page", null, "/crm")).not.toBe(favoriteKey("page", null, "/tasks"));
  });
  it("only allows app-relative hrefs", () => {
    expect(safeHref("/crm?x=1")).toBe("/crm?x=1");
    expect(safeHref("//evil.com")).toBeNull();
    expect(safeHref("https://evil.com")).toBeNull();
    expect(safeHref(5)).toBeNull();
  });
});
