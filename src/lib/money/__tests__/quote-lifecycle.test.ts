import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  releaseForQuote: vi.fn(),
  emitEvent: vi.fn(),
  enqueueNotification: vi.fn(),
}));

vi.mock("@/lib/dsql", () => ({ query: mocks.query, queryOne: mocks.queryOne, withRetry: (fn: () => unknown) => fn(), transaction: vi.fn() }));
vi.mock("@/lib/inventory/stock", () => ({ releaseForQuote: mocks.releaseForQuote }));
vi.mock("@/lib/events/bus", () => ({ emitEvent: mocks.emitEvent, EVENT_TYPES: [] }));
vi.mock("@/lib/notifications/outbox", () => ({ enqueueNotification: mocks.enqueueNotification }));
vi.mock("@/lib/docs/numbering", () => ({ nextDocNumber: vi.fn() }));
vi.mock("@/lib/share-tokens", () => ({ issueShareToken: vi.fn() }));

import { declineQuote, expireQuotes } from "@/lib/money/quotes";

const joined = (over: Record<string, unknown> = {}) => ({
  id: "q1",
  user_id: "org-1",
  contact_id: null,
  number: "Q-000001",
  status: "sent",
  currency: "USD",
  subtotal_minor: 100,
  tax_minor: 0,
  total_minor: 100,
  valid_until: null,
  terms_version: "v1",
  terms_text: "t",
  notes: null,
  current_version: 1,
  created_at: "2026-01-01",
  updated_at: "2026-01-01",
  sent_at: null,
  accepted_at: null,
  contact_name: "Ada",
  contact_email: "ada@example.com",
  items: "[]",
  ...over,
});

beforeEach(() => {
  mocks.query.mockReset();
  mocks.queryOne.mockReset();
  mocks.releaseForQuote.mockReset().mockResolvedValue([{ product_id: "p1", qty: 2 }]);
  mocks.emitEvent.mockReset().mockResolvedValue(undefined);
  mocks.enqueueNotification.mockReset().mockResolvedValue(undefined);
});

describe("declineQuote", () => {
  it("public decline flips status, releases stock, emits quote.declined and notifies the owner", async () => {
    mocks.queryOne
      .mockResolvedValueOnce(joined()) // getQuoteById
      .mockResolvedValueOnce({ user_id: "org-1" }) // owner lookup
      .mockResolvedValueOnce(joined({ status: "declined" })); // re-read
    mocks.query.mockResolvedValueOnce([{ id: "q1" }]); // UPDATE … RETURNING
    const out = await declineQuote(null, "q1", "  Too expensive  ", { by: "client" });
    expect(out.quote.status).toBe("declined");
    expect(out.released).toEqual([{ product_id: "p1", qty: 2 }]);
    expect(mocks.releaseForQuote).toHaveBeenCalledWith("org-1", "q1", "Quote declined");
    expect(mocks.emitEvent).toHaveBeenCalledWith("org-1", expect.objectContaining({ type: "quote.declined", entity: "quote", entityId: "q1", data: expect.objectContaining({ by: "client", reason: "Too expensive" }) }));
    expect(mocks.enqueueNotification).toHaveBeenCalledWith("org-1", expect.objectContaining({ channel: "in_app", subject: "Quote Q-000001 declined" }));
    const sql = String(mocks.query.mock.calls[0][0]);
    expect(sql).toMatch(/status = 'declined'/);
    expect(sql).toMatch(/status IN \('draft','sent','viewed'\)/);
  });

  it("refuses accepted quotes and never touches stock", async () => {
    mocks.queryOne.mockResolvedValueOnce(joined({ status: "accepted" }));
    await expect(declineQuote("org-1", "q1")).rejects.toThrow(/accepted/);
    expect(mocks.releaseForQuote).not.toHaveBeenCalled();
    expect(mocks.emitEvent).not.toHaveBeenCalled();
  });

  it("falls back to a column-less UPDATE before the migration and does not notify on owner declines", async () => {
    mocks.queryOne.mockResolvedValueOnce(joined({ status: "viewed" })).mockResolvedValueOnce(joined({ status: "declined" }));
    mocks.query.mockRejectedValueOnce(new Error('column "declined_at" does not exist')).mockResolvedValueOnce([{ id: "q1" }]);
    const out = await declineQuote("org-1", "q1", null);
    expect(out.quote.status).toBe("declined");
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.enqueueNotification).not.toHaveBeenCalled();
    expect(mocks.emitEvent).toHaveBeenCalledWith("org-1", expect.objectContaining({ data: expect.objectContaining({ by: "owner" }) }));
  });

  it("loses the race gracefully when another caller already changed the status", async () => {
    mocks.queryOne.mockResolvedValueOnce(joined());
    mocks.query.mockResolvedValueOnce([]);
    await expect(declineQuote("org-1", "q1")).rejects.toThrow(/no longer/);
    expect(mocks.releaseForQuote).not.toHaveBeenCalled();
  });
});

describe("expireQuotes", () => {
  it("expires due quotes, releases stock per quote and emits quote.expired", async () => {
    mocks.query
      .mockResolvedValueOnce([
        { id: "q1", user_id: "org-1", number: "Q-1", valid_until: "2026-01-01" },
        { id: "q2", user_id: "org-2", number: "Q-2", valid_until: "2026-01-02" },
      ])
      .mockResolvedValueOnce([{ id: "q1" }]) // q1 flipped
      .mockResolvedValueOnce([]); // q2 lost the race
    mocks.releaseForQuote.mockResolvedValueOnce([]);
    const out = await expireQuotes(200);
    expect(out).toEqual({ scanned: 2, expired: 1, released: 0 });
    expect(String(mocks.query.mock.calls[0][0])).toMatch(/valid_until < NOW\(\)/);
    expect(mocks.query.mock.calls[0][1]).toEqual([200]);
    expect(mocks.releaseForQuote).toHaveBeenCalledTimes(1);
    expect(mocks.releaseForQuote).toHaveBeenCalledWith("org-1", "q1", "Quote expired");
    expect(mocks.emitEvent).toHaveBeenCalledTimes(1);
    expect(mocks.emitEvent).toHaveBeenCalledWith("org-1", expect.objectContaining({ type: "quote.expired", entityId: "q1" }));
  });

  it("clamps the limit and survives a missing expired_at column", async () => {
    mocks.query
      .mockResolvedValueOnce([{ id: "q1", user_id: "org-1", number: "Q-1", valid_until: "2026-01-01" }])
      .mockRejectedValueOnce(new Error("column expired_at does not exist"))
      .mockResolvedValueOnce([{ id: "q1" }]);
    const out = await expireQuotes(99_999);
    expect(mocks.query.mock.calls[0][1]).toEqual([1000]);
    expect(out.expired).toBe(1);
    expect(out.released).toBe(1);
  });
});
