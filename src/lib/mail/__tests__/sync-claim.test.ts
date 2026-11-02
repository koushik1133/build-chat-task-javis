import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const queryOne = vi.fn();
vi.mock("@/lib/dsql", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
}));
vi.mock("@/lib/receptionist/inbound-agent", () => ({ handleInboundMessage: vi.fn() }));
vi.mock("@/lib/twilio-webhook", () => ({ parseConversation: () => [], saveConversation: vi.fn() }));
vi.mock("@/lib/events/bus", () => ({ emitEvent: vi.fn() }));
vi.mock("@/lib/mail/index", () => ({ ensureFreshAuth: vi.fn(), getMailAccountById: vi.fn(), getMailProvider: vi.fn() }));

import { claimAccountForSync, MANUAL_SYNC_GAP_MS, syncDueAccounts } from "@/lib/mail/sync";

beforeEach(() => {
  query.mockReset().mockResolvedValue([]);
  queryOne.mockReset();
});

describe("claimAccountForSync", () => {
  it("claims with a conditional UPDATE on last_sync_at (lease-safe)", async () => {
    queryOne.mockResolvedValueOnce({ id: "a1" });
    const before = Date.now();
    expect(await claimAccountForSync("a1", MANUAL_SYNC_GAP_MS)).toBe(true);
    const [sql, params] = queryOne.mock.calls[0] as [string, [string, string]];
    expect(sql).toContain("SET last_sync_at = NOW()");
    expect(sql).toContain("last_sync_at IS NULL OR last_sync_at < $2");
    expect(sql).toContain("status <> 'disabled'");
    expect(params[0]).toBe("a1");
    const cutoff = new Date(params[1]).getTime();
    expect(before - cutoff).toBeGreaterThanOrEqual(MANUAL_SYNC_GAP_MS - 5);
    expect(before - cutoff).toBeLessThan(MANUAL_SYNC_GAP_MS + 5_000);
  });

  it("returns false when another sync already holds the lease", async () => {
    queryOne.mockResolvedValueOnce(null);
    expect(await claimAccountForSync("a1", 1000)).toBe(false);
  });

  it("syncDueAccounts skips accounts it cannot claim", async () => {
    query.mockResolvedValueOnce([{ id: "a1" }, { id: "a2" }]);
    queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const out = await syncDueAccounts(5);
    expect(out.claimed).toBe(0);
  });
});
