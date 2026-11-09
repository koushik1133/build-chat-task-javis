import { describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  query: vi.fn<(sql: string, values?: unknown[]) => Promise<unknown[]>>(async () => []),
  queryOne: vi.fn<(sql: string, values?: unknown[]) => Promise<unknown>>(async () => null),
  withRetry: vi.fn(async <T,>(fn: () => Promise<T>) => fn()),
}));
vi.mock("@/lib/dsql", () => db);
const outbox = vi.hoisted(() => ({ enqueueNotification: vi.fn(async () => "n1") }));
vi.mock("@/lib/notifications/outbox", () => outbox);
vi.mock("@/lib/money/invoices", () => ({ createInvoiceFromQuote: vi.fn() }));
vi.mock("@/lib/inventory/stock", () => ({ reserveForQuote: vi.fn() }));
vi.mock("@/lib/pdf/documents", () => ({ fingerprintAcceptance: vi.fn() }));
const quotes = vi.hoisted(() => ({
  getQuoteById: vi.fn(async () => ({ id: "q1", status: "sent", current_version: 1, number: "Q-1" })),
  declineQuote: vi.fn(),
  businessName: vi.fn(async () => "Acme"),
  quoteIsExpired: vi.fn(() => false),
}));
vi.mock("@/lib/money/quotes", () => quotes);

import { assertRecipientMatches, hashOtp, requestAcceptanceOtp, verifyOtp } from "@/lib/money/acceptance";

describe("OTP recipient binding", () => {
  it("null recipient keeps the legacy behaviour (any email)", () => {
    expect(() => assertRecipientMatches("anyone@example.test", null)).not.toThrow();
    expect(() => assertRecipientMatches("anyone@example.test", undefined)).not.toThrow();
  });

  it("matches case-insensitively and ignores surrounding whitespace", () => {
    expect(() => assertRecipientMatches("  Ada@Example.TEST ", "ada@example.test")).not.toThrow();
    expect(() => assertRecipientMatches("eve@example.test", "ada@example.test")).toThrow(/different email address/);
  });

  it("requestAcceptanceOtp refuses a mismatched recipient before touching the DB", async () => {
    db.query.mockClear();
    outbox.enqueueNotification.mockClear();
    await expect(requestAcceptanceOtp("q1", "eve@example.test", "accept", "ada@example.test")).rejects.toThrow(/different email/);
    expect(db.query).not.toHaveBeenCalled();
    expect(outbox.enqueueNotification).not.toHaveBeenCalled();
  });

  it("requestAcceptanceOtp proceeds for the bound recipient", async () => {
    db.queryOne.mockResolvedValueOnce({ user_id: "owner" });
    const out = await requestAcceptanceOtp("q1", "ADA@example.test", "accept", "ada@example.test");
    expect(out.ok).toBe(true);
    expect(outbox.enqueueNotification).toHaveBeenCalledTimes(1);
  });

  it("verifyOtp enforces the recipient even with a valid code", async () => {
    const good = hashOtp("q1", "eve@example.test", "123456", "accept");
    db.queryOne.mockResolvedValueOnce({ id: "c1", otp_hash: good, otp_expires_at: null, otp_attempts: 0, version: 1 });
    await expect(verifyOtp("q1", "eve@example.test", "123456", "accept", 1, "ada@example.test")).rejects.toThrow(/different email/);
    db.queryOne.mockResolvedValueOnce({ id: "c1", otp_hash: good, otp_expires_at: null, otp_attempts: 0, version: 1 });
    await expect(verifyOtp("q1", "eve@example.test", "123456", "accept", 1, null)).resolves.toEqual({ id: "c1" });
  });
});
