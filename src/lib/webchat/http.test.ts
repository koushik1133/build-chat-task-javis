import { describe, expect, it } from "vitest";
import { sessionTokenFrom } from "@/lib/webchat/http";

describe("widget session token extraction", () => {
  const tok = "a".repeat(32);
  it("reads the Authorization header", () => {
    expect(sessionTokenFrom(new Request("https://x.test/api", { headers: { authorization: `Bearer ${tok}` } }))).toBe(tok);
  });
  it("ignores ?token= unless the route opts in (SSE only)", () => {
    const req = new Request(`https://x.test/api?token=${tok}`);
    expect(sessionTokenFrom(req)).toBeNull();
    expect(sessionTokenFrom(req, { allowQuery: true })).toBe(tok);
  });
});
