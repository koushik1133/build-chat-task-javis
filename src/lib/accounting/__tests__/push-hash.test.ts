import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The unchanged-skip in pushWithHash compares the stored link hash against the
 * hash of the provider-neutral payload. The stored hash must therefore be that
 * same neutral hash (not the provider-shaped body), or every cron scan re-pushes.
 */
const mocks = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn(), pushCustomer: vi.fn(), emitEvent: vi.fn() }));
vi.mock("@/lib/dsql", () => ({ query: mocks.query, queryOne: mocks.queryOne, withRetry: (fn: () => unknown) => fn(), transaction: vi.fn() }));
vi.mock("@/lib/events/bus", () => ({ emitEvent: mocks.emitEvent, EVENT_TYPES: [] }));
vi.mock("@/lib/money/invoices", () => ({ recordPayment: vi.fn() }));
vi.mock("@/lib/secure-store", () => ({ isEncryptionConfigured: () => true, encryptSecret: (s: string) => `enc:${s}`, decryptSecret: (s: string) => s.replace(/^enc:/, "") }));
vi.mock("@/lib/accounting/providers/simulated", () => ({
  simulatedProvider: { id: "simulated", label: "Sim", configured: () => true, unavailableReason: () => null, refresh: async (a: unknown) => a, pushCustomer: mocks.pushCustomer },
}));

import { pushEntity } from "@/lib/accounting/sync";
import { payloadHash, stripVolatile } from "@/lib/accounting/mapping";

const conn = {
  id: "conn-1", user_id: "org-1", provider: "simulated", auth: null, realm_id: null, tenant_id: null, company_name: "Sim", status: "connected",
  sync_cursor: null, last_sync_at: null, last_error: null, settings: "{}", created_at: "2026-01-01T00:00:00Z",
};
const contact = { id: "c-1", full_name: "Maya Patel", email: "maya@example.com", phone: null, company: "Northwind" };
const neutralHash = payloadHash(stripVolatile({ ...contact }));

describe("pushWithHash hash bookkeeping", () => {
  let link: Record<string, unknown> | null;
  beforeEach(() => {
    link = null;
    mocks.query.mockReset().mockResolvedValue([]);
    mocks.pushCustomer.mockReset().mockResolvedValue({ remoteId: "QBO-9", remoteUpdatedAt: null, payload: { DisplayName: "Maya Patel", Id: "QBO-9", SyncToken: "3" } });
    mocks.queryOne.mockReset().mockImplementation(async (sql: string) => {
      if (sql.includes("FROM accounting_connections")) return conn;
      if (sql.includes("FROM accounting_links")) return link;
      if (sql.includes("FROM crm_contacts")) return contact;
      return null;
    });
  });

  it("stores the hash of the neutral payload it compares against, not the provider body", async () => {
    const out = await pushEntity("conn-1", "contact", "c-1");
    expect(out.status).toBe("ok");
    const insert = mocks.query.mock.calls.find((c) => String(c[0]).includes("INSERT INTO accounting_links"));
    expect(insert).toBeDefined();
    const params = insert?.[1] as unknown[];
    expect(params[10]).toBe(neutralHash);
    expect(params[10]).not.toBe(payloadHash(stripVolatile({ DisplayName: "Maya Patel" })));
  });

  it("skips an unchanged entity on the next push instead of re-sending", async () => {
    link = { id: "l-1", remote_id: "QBO-9", remote_meta: null, hash: neutralHash, error: null };
    const out = await pushEntity("conn-1", "contact", "c-1");
    expect(out).toMatchObject({ status: "skipped", remoteId: "QBO-9", message: "unchanged" });
    expect(mocks.pushCustomer).not.toHaveBeenCalled();
  });

  it("re-pushes when the payload changed or the last push errored", async () => {
    link = { id: "l-1", remote_id: "QBO-9", remote_meta: null, hash: "stale", error: null };
    expect((await pushEntity("conn-1", "contact", "c-1")).status).toBe("ok");
    link = { id: "l-1", remote_id: "QBO-9", remote_meta: null, hash: neutralHash, error: "boom" };
    expect((await pushEntity("conn-1", "contact", "c-1")).status).toBe("ok");
    expect(mocks.pushCustomer).toHaveBeenCalledTimes(2);
  });
});
