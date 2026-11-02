import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn() }));
vi.mock("@/lib/dsql", () => ({ query: mocks.query, queryOne: mocks.queryOne, withRetry: (fn: () => unknown) => fn(), transaction: vi.fn() }));
vi.mock("@/lib/agents/queue", () => ({ enqueueJob: vi.fn() }));
vi.mock("@/lib/table-exists", () => ({ tableExists: vi.fn(async () => true) }));

import { listReviews } from "@/lib/marketplace/catalog";

beforeEach(() => {
  mocks.query.mockReset().mockResolvedValue([]);
  mocks.queryOne.mockReset().mockResolvedValue(null);
});

describe("listReviews visibility", () => {
  it("returns nothing for a listing the caller cannot see (private listing of another org)", async () => {
    mocks.queryOne.mockResolvedValueOnce(null); // getListing: not public and not ours
    const out = await listReviews("org-b", "listing-private-of-org-a");
    expect(out).toEqual([]);
    const visibility = mocks.queryOne.mock.calls[0];
    expect(String(visibility[0])).toContain("(visibility = 'public' AND published_at IS NOT NULL) OR user_id = $2");
    expect(visibility[1]).toEqual(["listing-private-of-org-a", "org-b"]);
    // The reviews table was never read.
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("FROM marketplace_reviews WHERE listing_id"))).toBe(false);
  });
  it("lists reviews once the listing is visible, marking the caller's own", async () => {
    const row = { id: "l1", user_id: "org-a", kind: "agent", slug: "s", title: "T", summary: null, description_md: null, category: null, tags: "[]", definition: "{}", version: 1, visibility: "public", install_count: 0, rating_sum: 0, rating_count: 0, created_at: "2026-01-01", updated_at: "2026-01-01", published_at: "2026-01-01" };
    mocks.queryOne.mockResolvedValueOnce(row);
    mocks.query
      .mockResolvedValueOnce([]) // installedIds
      .mockResolvedValueOnce([{ id: "r1", user_id: "org-b", listing_id: "l1", rating: 5, body: "great", created_at: "2026-01-02" }]);
    const out = await listReviews("org-b", "l1");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "r1", mine: true, rating: 5 });
    expect(out[0]).not.toHaveProperty("user_id");
  });
});
