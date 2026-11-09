import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pre-migration fallbacks must trigger only on "column does not exist"
 * (Postgres 42703). Any other failure propagates: a transient error must never
 * silently downgrade a recipient-bound share link to an open one, nor hide a
 * customer's payments from their statement.
 */
const db = vi.hoisted(() => ({
  query: vi.fn<(sql: string, values?: unknown[]) => Promise<unknown[]>>(async () => []),
  queryOne: vi.fn<(sql: string, values?: unknown[]) => Promise<unknown>>(async () => null),
}));
vi.mock("@/lib/dsql", async () => {
  const actual = await vi.importActual<typeof import("@/lib/dsql")>("@/lib/dsql");
  return { ...db, isUndefinedColumn: actual.isUndefinedColumn, DbError: actual.DbError };
});
vi.mock("@/lib/table-exists", () => ({ tableExists: vi.fn(async () => false) }));

import { DbError, isUndefinedColumn } from "@/lib/dsql";
import { issueShareToken } from "@/lib/share-tokens";
import { loadStatementEntries } from "@/lib/money/statements";

const missingColumn = () => new DbError('column "recipient" of relation "share_tokens" does not exist', { code: "42703" });
const timeout = () => new DbError("canceling statement due to statement timeout", { code: "57014" });

describe("isUndefinedColumn", () => {
  it("recognises 42703 on the error, on the wrapped cause, and in the message", () => {
    expect(isUndefinedColumn(missingColumn())).toBe(true);
    expect(isUndefinedColumn({ cause: { code: "42703" } })).toBe(true);
    expect(isUndefinedColumn(new Error('column p.refunded_minor does not exist'))).toBe(true);
    expect(isUndefinedColumn(timeout())).toBe(false);
    expect(isUndefinedColumn(new Error("connection reset"))).toBe(false);
    expect(isUndefinedColumn(null)).toBe(false);
  });
});

describe("issueShareToken recipient binding", () => {
  beforeEach(() => db.query.mockReset());

  it("falls back to an unbound insert only when the recipient column is missing", async () => {
    db.query.mockRejectedValueOnce(missingColumn());
    db.query.mockResolvedValueOnce([]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const out = await issueShareToken("org1", "quote", "q1", 30, { recipient: "Client@Example.com" });
    warn.mockRestore();
    expect(out.path).toMatch(/^\/p\/q\//);
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query.mock.calls[0][0]).toMatch(/recipient\)/);
    expect(db.query.mock.calls[0][1]?.[6]).toBe("client@example.com");
    expect(db.query.mock.calls[1][0]).not.toMatch(/recipient/);
  });

  it("propagates any other insert failure instead of storing an unbound token", async () => {
    db.query.mockRejectedValueOnce(timeout());
    await expect(issueShareToken("org1", "quote", "q1", 30, { recipient: "client@example.com" })).rejects.toThrow(/statement timeout/);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("issues unbound tokens with a single insert when no recipient is given (legacy behaviour)", async () => {
    db.query.mockResolvedValueOnce([]);
    await issueShareToken("org1", "pay", "i1", 30);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0][0]).not.toMatch(/recipient/);
  });
});

describe("loadStatementEntries payments", () => {
  beforeEach(() => {
    db.query.mockReset();
    db.queryOne.mockReset();
  });
  const invoiceRows = [{ id: "i1", number: "INV-1", currency: "USD", total_minor: "1000", issued: "2026-01-05T00:00:00Z" }];

  it("re-reads payments without the refund columns when they are not migrated yet", async () => {
    db.query.mockResolvedValueOnce(invoiceRows);
    db.query.mockRejectedValueOnce(new DbError('column p.refunded_minor does not exist', { code: "42703" }));
    db.query.mockResolvedValueOnce([{ id: "p1", invoice_id: "i1", number: "INV-1", provider: "manual", amount_minor: "1000", currency: "USD", created_at: "2026-01-06T00:00:00Z", refunded_minor: null, refunded_at: null }]);
    const entries = await loadStatementEntries("org1", "c1");
    expect(entries.map((e) => [e.kind, e.amount_minor])).toEqual([["invoice", 1000], ["payment", -1000]]);
    expect(db.query.mock.calls[2][0]).toMatch(/NULL::bigint AS refunded_minor/);
  });

  it("surfaces other payment query failures instead of reporting the customer as owing everything", async () => {
    db.query.mockResolvedValueOnce(invoiceRows);
    db.query.mockRejectedValueOnce(timeout());
    await expect(loadStatementEntries("org1", "c1")).rejects.toThrow(/statement timeout/);
  });

  it("adds a refund entry that re-increases the balance", async () => {
    db.query.mockResolvedValueOnce(invoiceRows);
    db.query.mockResolvedValueOnce([{ id: "p1", invoice_id: "i1", number: "INV-1", provider: "simulated", amount_minor: "1000", currency: "USD", created_at: "2026-01-06T00:00:00Z", refunded_minor: "250", refunded_at: "2026-01-08T00:00:00Z" }]);
    const entries = await loadStatementEntries("org1", "c1");
    expect(entries.map((e) => [e.kind, e.amount_minor])).toEqual([["invoice", 1000], ["payment", -1000], ["refund", 250]]);
  });
});
