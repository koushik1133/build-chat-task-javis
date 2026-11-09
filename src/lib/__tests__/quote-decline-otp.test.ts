import { describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  query: vi.fn<(sql: string, values?: unknown[]) => Promise<unknown[]>>(async () => []),
  queryOne: vi.fn<(sql: string, values?: unknown[]) => Promise<unknown>>(async () => null),
  withRetry: vi.fn(async <T,>(fn: () => Promise<T>) => fn()),
}));
vi.mock("@/lib/dsql", () => db);
vi.mock("@/lib/notifications/outbox", () => ({ enqueueNotification: vi.fn(async () => undefined) }));
vi.mock("@/lib/money/invoices", () => ({ createInvoiceFromQuote: vi.fn() }));
vi.mock("@/lib/inventory/stock", () => ({ reserveForQuote: vi.fn() }));
vi.mock("@/lib/pdf/documents", () => ({ fingerprintAcceptance: vi.fn() }));
const quotes = vi.hoisted(() => ({
  getQuoteById: vi.fn(),
  declineQuote: vi.fn(),
  businessName: vi.fn(async () => "Acme"),
  quoteIsExpired: vi.fn(() => false),
}));
vi.mock("@/lib/money/quotes", () => quotes);

import { declineQuoteVerified, hashOtp, verifyOtp } from "@/lib/money/acceptance";

const quote = { id: "q1", status: "sent", current_version: 1, number: "Q-1" };

describe("quote OTP purposes", () => {
  it("accept and decline codes hash differently", () => {
    expect(hashOtp("q1", "a@b.co", "123456", "accept")).not.toBe(hashOtp("q1", "a@b.co", "123456", "decline"));
    expect(hashOtp("q1", "a@b.co", "123456")).toBe(hashOtp("q1", "A@B.CO", "123456", "accept"));
  });

  it("verifyOtp looks up the challenge by purpose and rejects a wrong code", async () => {
    db.queryOne.mockResolvedValueOnce({ id: "c1", otp_hash: hashOtp("q1", "a@b.co", "111111", "decline"), otp_expires_at: null, otp_attempts: 0, version: 1 });
    await expect(verifyOtp("q1", "a@b.co", "222222", "decline", 1)).rejects.toThrow(/Incorrect/);
    expect(String(db.queryOne.mock.calls[0][0])).toMatch(/purpose, 'accept'\) = \$3/);
    expect(db.queryOne.mock.calls[0][1]).toEqual(["q1", "a@b.co", "decline"]);
    expect(String(db.query.mock.calls.at(-1)?.[0])).toMatch(/otp_attempts \+ 1/);
  });

  it("declineQuoteVerified requires a code before declining", async () => {
    quotes.getQuoteById.mockResolvedValue(quote);
    db.queryOne.mockResolvedValueOnce(null);
    await expect(declineQuoteVerified("q1", { otp: "123456", email: "a@b.co", reason: null })).rejects.toThrow(/Request a verification code/);
    expect(quotes.declineQuote).not.toHaveBeenCalled();
  });

  it("declineQuoteVerified consumes the challenge and declines as the client", async () => {
    quotes.getQuoteById.mockResolvedValue(quote);
    quotes.declineQuote.mockResolvedValue({ quote: { ...quote, status: "declined" } });
    db.queryOne.mockResolvedValueOnce({ id: "c2", otp_hash: hashOtp("q1", "a@b.co", "123456", "decline"), otp_expires_at: null, otp_attempts: 0, version: 1 });
    const out = await declineQuoteVerified("q1", { otp: "123456", email: "a@b.co", reason: "too pricey" });
    expect(out.quote.status).toBe("declined");
    expect(quotes.declineQuote).toHaveBeenCalledWith(null, "q1", "too pricey", { by: "client" });
    expect(db.query.mock.calls.some((c) => /DELETE FROM quote_acceptances WHERE id/.test(String(c[0])))).toBe(true);
  });
});
