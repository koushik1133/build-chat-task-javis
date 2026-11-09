import { describe, expect, it } from "vitest";
import { isSafeRelativePath } from "@/lib/safe-next";

describe("isSafeRelativePath", () => {
  it("accepts ordinary app paths", () => {
    for (const p of ["/", "/home", "/billing?new=quote", "/settings/plan?upgrade=growth&interval=year"]) expect(isSafeRelativePath(p)).toBe(true);
  });
  it("rejects open-redirect forms", () => {
    for (const p of ["//evil.com", "/\\evil.com", "/\t/evil.com", "/\n/evil.com", "https://evil.com", "evil.com", "", "/a\u0000b", "/\\/evil.com"]) expect(isSafeRelativePath(p)).toBe(false);
  });
  it("rejects non-strings and huge values", () => {
    expect(isSafeRelativePath(null)).toBe(false);
    expect(isSafeRelativePath("/" + "a".repeat(3000))).toBe(false);
  });
});
