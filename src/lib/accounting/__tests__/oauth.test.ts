import { describe, expect, it } from "vitest";
import { accountingStateSecret, createAccountingState, verifyAccountingState } from "@/lib/accounting/oauth";
import { qboBaseUrl } from "@/lib/accounting/providers/quickbooks";
import { parseXeroDate } from "@/lib/accounting/providers/xero";

describe("accounting OAuth state", () => {
  it("refuses the dev secret in production and derives a module-specific secret", () => {
    expect(() => accountingStateSecret({ NODE_ENV: "production" })).toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
    expect(accountingStateSecret({ NODE_ENV: "production", CRON_SECRET: "c".repeat(40) })).toBe(`acct:${"c".repeat(40)}`);
    expect(accountingStateSecret({ NODE_ENV: "test" })).toBe("accounting-oauth-dev-secret");
  });
  it("binds state to provider, cookie and a 10-minute window", () => {
    const now = 1_700_000_000_000;
    const state = createAccountingState("quickbooks", now);
    expect(verifyAccountingState(state, state, "quickbooks", now + 1000)).toBe(true);
    expect(verifyAccountingState(state, state, "xero", now + 1000)).toBe(false);
    expect(verifyAccountingState(state, "other", "quickbooks", now + 1000)).toBe(false);
    expect(verifyAccountingState(state, state, "quickbooks", now + 11 * 60 * 1000)).toBe(false);
    const forged = state.replace(/\.[^.]+$/, ".AAAA");
    expect(verifyAccountingState(forged, forged, "quickbooks", now)).toBe(false);
    expect(verifyAccountingState(null, state, "quickbooks", now)).toBe(false);
  });
});

describe("provider helpers", () => {
  it("selects the QBO base URL from QBO_ENV", () => {
    expect(qboBaseUrl({})).toBe("https://sandbox-quickbooks.api.intuit.com");
    expect(qboBaseUrl({ QBO_ENV: "production" })).toBe("https://quickbooks.api.intuit.com");
  });
  it("parses Xero's /Date()/ format", () => {
    expect(parseXeroDate("/Date(1700000000000+0000)/")).toBe("2023-11-14T22:13:20.000Z");
    expect(parseXeroDate("2026-01-01")).toBe("2026-01-01T00:00:00.000Z");
    expect(parseXeroDate(null)).toBeNull();
  });
});
