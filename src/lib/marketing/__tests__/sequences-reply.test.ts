import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn(), withRetry: (fn: () => unknown) => fn(), transaction: vi.fn() }));
vi.mock("@/lib/dsql", () => db);
vi.mock("@/lib/events/bus", () => ({ emitEvent: vi.fn(async () => undefined), EVENT_TYPES: [] }));
vi.mock("@/lib/table-exists", () => ({ tableExists: vi.fn(async () => true) }));
vi.mock("@/lib/marketing/send", () => ({ loadContact: vi.fn(), sendMarketingMessage: vi.fn() }));

import { hasRepliedSince } from "@/lib/marketing/sequences";

describe("sequences: reply detection", () => {
  beforeEach(() => {
    db.query.mockReset();
    db.queryOne.mockReset();
  });

  it("matches the contact email literally (LIKE metacharacters escaped)", async () => {
    db.queryOne.mockResolvedValueOnce(null);
    const replied = await hasRepliedSince("org-1", { id: "c1", full_name: "A B", email: "a_b%@x.com", phone: null, company: null }, "2026-01-01T00:00:00Z");
    expect(replied).toBe(false);
    const [sql, params] = db.queryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("lower(from_addr) LIKE $2");
    expect(params[1]).toBe("%a\\_b\\%@x.com%");
  });

  it("reports a reply when an inbound mail from the address exists", async () => {
    db.queryOne.mockResolvedValueOnce({ id: "m1" });
    expect(await hasRepliedSince("org-1", { id: "c1", full_name: "A", email: "a@x.com", phone: null, company: null }, "2026-01-01T00:00:00Z")).toBe(true);
  });
});
