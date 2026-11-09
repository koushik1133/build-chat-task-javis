import { describe, expect, it } from "vitest";
import { giftCardAttemptAllowed } from "../giftcards";
import { rateLimitAsync } from "@/lib/request-limits";

describe("giftCardAttemptAllowed", () => {
  it("blocked per-IP attempts do not consume the global bucket", async () => {
    const ip = "198.51.100.77";
    for (let i = 0; i < 40; i++) await giftCardAttemptAllowed(ip);
    // 10 allowed in the minute window; the other 30 must not have touched gcard:g.
    const probe = await rateLimitAsync("gcard:g", 600, 60_000);
    expect(600 - probe.remaining).toBeLessThanOrEqual(12);
  });
});
