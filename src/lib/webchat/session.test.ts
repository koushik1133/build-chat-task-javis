import { describe, expect, it } from "vitest";
import { hashIp, hashSessionToken, isExpired, newSessionToken, tokenLooksValid } from "./session";

describe("webchat session tokens", () => {
  it("hashes deterministically and never stores the plain token", () => {
    const t = newSessionToken();
    expect(tokenLooksValid(t)).toBe(true);
    const h = hashSessionToken(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(hashSessionToken(t));
    expect(h).not.toContain(t);
    expect(hashSessionToken(newSessionToken())).not.toBe(h);
  });
  it("validates token shape", () => {
    expect(tokenLooksValid("short")).toBe(false);
    expect(tokenLooksValid("a".repeat(65))).toBe(false);
    expect(tokenLooksValid("has space in it and is long enough")).toBe(false);
    expect(tokenLooksValid(null)).toBe(false);
  });
  it("detects expiry", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(isExpired("2026-01-01T00:00:01Z", now)).toBe(false);
    expect(isExpired("2025-12-31T23:59:59Z", now)).toBe(true);
    expect(isExpired("garbage", now)).toBe(true);
  });
  it("hashes ips but not unknown", () => {
    expect(hashIp("unknown")).toBeNull();
    expect(hashIp(null)).toBeNull();
    expect(hashIp("1.2.3.4")).toHaveLength(32);
  });
});
