import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * pullPaymentsFor with a mocked dsql: one remote payment is new, one was pushed
 * by us, one is already in invoice_payments. Only the new one reaches recordPayment.
 */
const mocks = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn(), recordPayment: vi.fn(), emitEvent: vi.fn(), pull: vi.fn() }));
vi.mock("@/lib/dsql", () => ({ query: mocks.query, queryOne: mocks.queryOne, withRetry: (fn: () => unknown) => fn(), transaction: vi.fn() }));
vi.mock("@/lib/events/bus", () => ({ emitEvent: mocks.emitEvent, EVENT_TYPES: [] }));
vi.mock("@/lib/money/invoices", () => ({ recordPayment: mocks.recordPayment }));
vi.mock("@/lib/secure-store", () => ({ isEncryptionConfigured: () => true, encryptSecret: (s: string) => `enc:${s}`, decryptSecret: (s: string) => s.replace(/^enc:/, "") }));
vi.mock("@/lib/accounting/providers/simulated", () => ({
  simulatedProvider: { id: "simulated", label: "Sim", configured: () => true, unavailableReason: () => null, refresh: async (a: unknown) => a, pullPayments: mocks.pull },
}));

import { pullPaymentsFor } from "@/lib/accounting/sync";
import type { AccountingConnectionRow } from "@/lib/accounting/types";

const conn: AccountingConnectionRow = {
  id: "conn-1", user_id: "org-1", provider: "simulated", auth: null, realm_id: null, tenant_id: null, company_name: "Sim", status: "connected",
  sync_cursor: null, last_sync_at: null, last_error: null, settings: "{}", created_at: "2026-01-01T00:00:00Z",
};

describe("pullPaymentsFor", () => {
  beforeEach(() => {
    mocks.pull.mockResolvedValue({
      payments: [
        { remoteId: "R-new", remoteInvoiceId: "QI-1", amountMinor: 5000, currency: "USD", paidAt: "2026-01-02T00:00:00Z" },
        { remoteId: "R-pushed", remoteInvoiceId: "QI-1", amountMinor: 100, currency: "USD", paidAt: null },
        { remoteId: "R-known", remoteInvoiceId: "QI-1", amountMinor: 100, currency: "USD", paidAt: null },
      ],
      cursor: "2026-01-03T00:00:00.000Z",
    });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("entity_kind = 'invoice' AND remote_id = ANY")) return [{ entity_id: "inv-1", remote_id: "QI-1" }];
      if (sql.includes("entity_kind = 'payment' AND remote_id = ANY")) return [{ remote_id: "R-pushed" }];
      if (sql.includes("p.provider_ref = ANY")) return [{ provider_ref: "R-known" }];
      return [];
    });
    mocks.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT currency FROM invoices")) return { currency: "USD" };
      if (sql.includes("SELECT id FROM invoice_payments")) return { id: "local-pay-1" };
      if (sql.includes("FROM accounting_links WHERE connection_id")) return null;
      return null;
    });
    mocks.recordPayment.mockResolvedValue({ status: "paid", duplicate: false });
  });

  it("records only the genuinely new remote payment with the accounting provider ref", async () => {
    const res = await pullPaymentsFor(conn);
    expect(res).toEqual({ recorded: 1, skipped: 2, errors: 0 });
    expect(mocks.recordPayment).toHaveBeenCalledTimes(1);
    expect(mocks.recordPayment).toHaveBeenCalledWith({ invoiceId: "inv-1", provider: "accounting:simulated", providerRef: "R-new", amountMinor: 5000, currency: "USD" });
    // link created for the pulled payment + log + cursor advanced
    const inserts = mocks.query.mock.calls.map((c) => String(c[0]));
    expect(inserts.some((s) => s.includes("INSERT INTO accounting_links"))).toBe(true);
    expect(inserts.some((s) => s.includes("INSERT INTO accounting_sync_log"))).toBe(true);
    const cursorCall = mocks.query.mock.calls.find((c) => String(c[0]).includes("sync_cursor = $2"));
    expect(cursorCall?.[1]).toEqual(["conn-1", "2026-01-03T00:00:00.000Z"]);
  });

  it("treats a recordPayment duplicate as skipped", async () => {
    mocks.recordPayment.mockResolvedValue({ status: "paid", duplicate: true });
    const res = await pullPaymentsFor(conn);
    expect(res).toEqual({ recorded: 0, skipped: 3, errors: 0 });
  });

  it("logs a pull error and keeps the connection usable for non-auth failures", async () => {
    mocks.pull.mockRejectedValue(new Error("rate limited"));
    const res = await pullPaymentsFor(conn);
    expect(res.errors).toBe(1);
    const markErr = mocks.query.mock.calls.find((c) => String(c[0]).includes("SET last_error"));
    expect(markErr?.[1]).toEqual(["conn-1", "rate limited", false]);
  });
});
