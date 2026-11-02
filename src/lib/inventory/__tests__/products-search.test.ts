import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("@/lib/dsql", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: vi.fn(),
  withRetry: (fn: () => unknown) => fn(),
}));

import { listProducts } from "@/lib/inventory/products";

describe("listProducts search", () => {
  beforeEach(() => query.mockReset());

  it("scopes to the org and escapes LIKE metacharacters in the needle", async () => {
    query.mockResolvedValue([]);
    await listProducts("owner-1", { q: "50%_Off" });
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toContain("user_id = $1");
    expect(params[0]).toBe("owner-1");
    expect(params[1]).toBe("%50\\%\\_off%");
  });
});
