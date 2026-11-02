import { describe, expect, it } from "vitest";
import { createOauthState, oauthStateSecret, verifyOauthState } from "@/lib/mail/oauth";

describe("mail OAuth state", () => {
  it("refuses the built-in dev secret in production", () => {
    expect(() => oauthStateSecret({ NODE_ENV: "production" })).toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
    expect(oauthStateSecret({ NODE_ENV: "production", CRON_SECRET: "c".repeat(40) })).toBe("c".repeat(40));
    expect(oauthStateSecret({ NODE_ENV: "test" })).toBe("mail-oauth-dev-secret");
  });
  it("binds state to the provider, the cookie and a 10-minute window", () => {
    const now = 1_700_000_000_000;
    const state = createOauthState("gmail", now);
    expect(verifyOauthState(state, state, "gmail", now + 1000)).toBe(true);
    expect(verifyOauthState(state, state, "outlook", now + 1000)).toBe(false);
    expect(verifyOauthState(state, "other", "gmail", now + 1000)).toBe(false);
    expect(verifyOauthState(state, state, "gmail", now + 11 * 60 * 1000)).toBe(false);
    const forged = state.replace(/\.[^.]+$/, ".AAAA");
    expect(verifyOauthState(forged, forged, "gmail", now)).toBe(false);
  });
});
