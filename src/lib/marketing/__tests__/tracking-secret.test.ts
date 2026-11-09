import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openToken, unsubscribeToken, verifyToken } from "../tracking";

const KEYS = ["MARKETING_TRACKING_SECRET", "MARKETING_TRACKING_SECRET_PREVIOUS", "CRON_SECRET"] as const;
beforeEach(() => {
  for (const k of KEYS) vi.stubEnv(k, "");
});
afterEach(() => vi.unstubAllEnvs());

describe("tracking secret rotation", () => {
  it("signs with the dedicated secret and verifies", () => {
    vi.stubEnv("MARKETING_TRACKING_SECRET", "new-secret-0123456789");
    vi.stubEnv("CRON_SECRET", "cron-secret-0123456789");
    const t = openToken("r1");
    expect(verifyToken(t)).toEqual({ kind: "open", recipientId: "r1" });
  });
  it("legacy CRON_SECRET-signed links still verify after the dedicated secret is introduced", () => {
    vi.stubEnv("CRON_SECRET", "cron-secret-0123456789");
    const legacy = unsubscribeToken("r2");
    vi.stubEnv("MARKETING_TRACKING_SECRET", "new-secret-0123456789");
    expect(verifyToken(legacy)).toEqual({ kind: "unsub", recipientId: "r2" });
  });
  it("previous secret verifies; a rotated-out secret does not", () => {
    vi.stubEnv("MARKETING_TRACKING_SECRET", "secret-one-0123456789");
    const old = openToken("r3");
    vi.stubEnv("MARKETING_TRACKING_SECRET", "secret-two-0123456789");
    expect(verifyToken(old)).toBeNull();
    vi.stubEnv("MARKETING_TRACKING_SECRET_PREVIOUS", "secret-one-0123456789");
    expect(verifyToken(old)).toEqual({ kind: "open", recipientId: "r3" });
    expect(verifyToken(openToken("r4"))).toEqual({ kind: "open", recipientId: "r4" });
  });
  it("throws signing in production when unset, but a dev fallback works", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CRON_SECRET", "cron-secret-0123456789");
    expect(() => openToken("r5")).toThrow(/MARKETING_TRACKING_SECRET/);
    vi.stubEnv("NODE_ENV", "development");
    expect(verifyToken(openToken("r5"))).not.toBeNull();
  });
});
