import { describe, expect, it } from "vitest";
import { AUTO_DISABLE_AFTER, BACKOFF_SCHEDULE_MS, MAX_ATTEMPTS, afterFailure, isSuccessStatus, nextRetryDelayMs, shouldAutoDisable } from "@/lib/webhooks/backoff";
import { isAllowedWebhookUrl } from "@/lib/webhooks/url";
import { matchesEventType, validateEventTypes } from "@/lib/webhooks/subscriptions";

describe("backoff schedule", () => {
  it("is 1m, 5m, 30m, 2h, 12h then dead", () => {
    expect(BACKOFF_SCHEDULE_MS).toEqual([60_000, 300_000, 1_800_000, 7_200_000, 43_200_000]);
    expect(nextRetryDelayMs(1)).toBe(60_000);
    expect(nextRetryDelayMs(2)).toBe(300_000);
    expect(nextRetryDelayMs(5)).toBe(43_200_000);
    expect(nextRetryDelayMs(6)).toBeNull();
    expect(MAX_ATTEMPTS).toBe(6);
  });
  it("afterFailure schedules the next attempt or marks dead", () => {
    const now = 1_000_000;
    expect(afterFailure(1, now)).toEqual({ status: "failed", nextAttemptAt: new Date(now + 60_000) });
    expect(afterFailure(3, now)).toEqual({ status: "failed", nextAttemptAt: new Date(now + 1_800_000) });
    expect(afterFailure(6, now)).toEqual({ status: "dead", nextAttemptAt: null });
  });
  it("auto-disables after 20 consecutive failures", () => {
    expect(AUTO_DISABLE_AFTER).toBe(20);
    expect(shouldAutoDisable(19)).toBe(false);
    expect(shouldAutoDisable(20)).toBe(true);
  });
  it("treats only 2xx as success (no redirect following)", () => {
    expect(isSuccessStatus(200)).toBe(true);
    expect(isSuccessStatus(204)).toBe(true);
    expect(isSuccessStatus(301)).toBe(false);
    expect(isSuccessStatus(500)).toBe(false);
  });
});

describe("SSRF guard", () => {
  const env = { NODE_ENV: "test" } as NodeJS.ProcessEnv;
  it("allows public https hosts only", () => {
    expect(isAllowedWebhookUrl("https://hooks.zapier.com/hooks/catch/1/abc", env)).toBe(true);
    expect(isAllowedWebhookUrl("http://hooks.zapier.com/x", env)).toBe(false);
    expect(isAllowedWebhookUrl("https://user:pw@hooks.example.com/x", env)).toBe(false);
    expect(isAllowedWebhookUrl("https://127.0.0.1/x", env)).toBe(false);
    expect(isAllowedWebhookUrl("https://[::1]/x", env)).toBe(false);
    expect(isAllowedWebhookUrl("https://169.254.169.254/latest/meta-data", env)).toBe(false);
    expect(isAllowedWebhookUrl("https://localhost/x", env)).toBe(false);
    expect(isAllowedWebhookUrl("https://db.internal/x", env)).toBe(false);
    expect(isAllowedWebhookUrl("https://intranet/x", env)).toBe(false);
    expect(isAllowedWebhookUrl("not a url", env)).toBe(false);
  });
  it("permits http://localhost only with the dev escape hatch outside production", () => {
    expect(isAllowedWebhookUrl("http://localhost:4000/hook", { NODE_ENV: "development", WEBHOOKS_ALLOW_INSECURE: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isAllowedWebhookUrl("http://localhost:4000/hook", { NODE_ENV: "production", WEBHOOKS_ALLOW_INSECURE: "1" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isAllowedWebhookUrl("http://10.0.0.5/hook", { NODE_ENV: "development", WEBHOOKS_ALLOW_INSECURE: "1" } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("event type matching", () => {
  it("supports exact, wildcard and prefix patterns", () => {
    expect(matchesEventType(["*"], "invoice.paid")).toBe(true);
    expect(matchesEventType(["invoice.paid"], "invoice.paid")).toBe(true);
    expect(matchesEventType(["invoice.*"], "invoice.sent")).toBe(true);
    expect(matchesEventType(["invoice.*"], "quote.sent")).toBe(false);
    expect(matchesEventType(["crm.contact.created"], "crm.contact.stage_changed")).toBe(false);
  });
  it("validates and de-duplicates the subscription list", () => {
    expect(validateEventTypes(undefined)).toEqual(["*"]);
    expect(validateEventTypes(["invoice.paid", " invoice.paid ", "quote.*"])).toEqual(["invoice.paid", "quote.*"]);
    expect(() => validateEventTypes(["DROP TABLE"])).toThrow(/Invalid event type/);
  });
});
