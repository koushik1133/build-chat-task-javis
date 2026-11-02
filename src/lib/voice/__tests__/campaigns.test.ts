import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const queryOne = vi.fn();
vi.mock("@/lib/dsql", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
}));

import { hasFilterCriteria, resolveContacts } from "@/lib/voice/campaigns";

beforeEach(() => {
  query.mockReset().mockResolvedValue([]);
  queryOne.mockReset();
});

describe("resolveContacts", () => {
  it("does not query the CRM for an empty filter object", async () => {
    expect(await resolveContacts("u1", { filter: {} })).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("queries with trimmed criteria when a filter is given", async () => {
    query.mockResolvedValueOnce([{ id: "k1", full_name: "Ana", phone: "+1", tags: null }]);
    const out = await resolveContacts("u1", { filter: { lifecycle: " lead " } });
    expect(out.map((c) => c.id)).toEqual(["k1"]);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("lifecycle = $2");
    expect(params).toEqual(["u1", "lead"]);
  });
});

describe("hasFilterCriteria", () => {
  it("treats an empty or blank filter as no filter so it cannot select the whole CRM", () => {
    expect(hasFilterCriteria(undefined)).toBe(false);
    expect(hasFilterCriteria(null)).toBe(false);
    expect(hasFilterCriteria({})).toBe(false);
    expect(hasFilterCriteria({ lifecycle: "  ", tag: null, q: "" })).toBe(false);
    expect(hasFilterCriteria({ lifecycle: "lead" })).toBe(true);
    expect(hasFilterCriteria({ q: "acme" })).toBe(true);
  });
});
