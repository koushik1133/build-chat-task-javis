import { describe, expect, it } from "vitest";
import { escapeLike, likeContains } from "@/lib/like";

describe("escapeLike / likeContains", () => {
  it("escapes LIKE metacharacters so user text matches literally", () => {
    expect(escapeLike("100%")).toBe("100\\%");
    expect(escapeLike("a_b")).toBe("a\\_b");
    expect(escapeLike("back\\slash")).toBe("back\\\\slash");
    expect(escapeLike("plain")).toBe("plain");
  });

  it("wraps the escaped needle in wildcards", () => {
    expect(likeContains("50%_off")).toBe("%50\\%\\_off%");
    // A bare "%" must not become a match-everything pattern.
    expect(likeContains("%")).toBe("%\\%%");
  });
});
