import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const queryOne = vi.fn();

vi.mock("@/lib/dsql", async () => {
  const actual = await vi.importActual<typeof import("@/lib/dsql")>("@/lib/dsql");
  return { ...actual, query: (...a: unknown[]) => query(...a), queryOne: (...a: unknown[]) => queryOne(...a) };
});

import { formatDocNumber, nextDocNumber } from "@/lib/docs/numbering";

describe("formatDocNumber", () => {
  it("zero-pads to six digits with the kind prefix", () => {
    expect(formatDocNumber("quote", 1)).toBe("Q-000001");
    expect(formatDocNumber("invoice", 42)).toBe("INV-000042");
    expect(formatDocNumber("invoice", 1_234_567)).toBe("INV-1234567");
  });
});

describe("nextDocNumber", () => {
  beforeEach(() => {
    query.mockReset();
    queryOne.mockReset();
  });

  it("claims 1 on first use via insert", async () => {
    queryOne.mockResolvedValueOnce(null);
    query.mockResolvedValueOnce([{ user_id: "u" }]);
    await expect(nextDocNumber("u", "quote")).resolves.toBe("Q-000001");
    expect(query.mock.calls[0][0]).toMatch(/INSERT INTO doc_counters/);
  });

  it("does a conditional update and returns the old value", async () => {
    queryOne.mockResolvedValueOnce({ next_value: 7 });
    query.mockResolvedValueOnce([{ user_id: "u" }]);
    await expect(nextDocNumber("u", "invoice")).resolves.toBe("INV-000007");
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/WHERE user_id = \$1 AND kind = \$2 AND next_value = \$4/);
    expect(params).toEqual(["u", "invoice", 8, 7]);
  });

  it("retries when the conditional update loses a race", async () => {
    // attempt 1: read 7, update matches 0 rows (someone else took it)
    queryOne.mockResolvedValueOnce({ next_value: 7 });
    query.mockResolvedValueOnce([]);
    // attempt 2: read 8, update succeeds
    queryOne.mockResolvedValueOnce({ next_value: 8 });
    query.mockResolvedValueOnce([{ user_id: "u" }]);
    await expect(nextDocNumber("u", "quote")).resolves.toBe("Q-000008");
    expect(queryOne).toHaveBeenCalledTimes(2);
  });

  it("retries on a DSQL serialization conflict", async () => {
    queryOne.mockResolvedValueOnce({ next_value: 3 });
    query.mockRejectedValueOnce(Object.assign(new Error("OC000 conflict"), { code: "40001" }));
    queryOne.mockResolvedValueOnce({ next_value: 3 });
    query.mockResolvedValueOnce([{ user_id: "u" }]);
    await expect(nextDocNumber("u", "quote")).resolves.toBe("Q-000003");
  });

  it("gives up after repeated races", async () => {
    for (let i = 0; i < 6; i++) {
      queryOne.mockResolvedValueOnce({ next_value: 1 });
      query.mockResolvedValueOnce([]);
    }
    await expect(nextDocNumber("u", "quote")).rejects.toThrow(/race/);
  });
});
