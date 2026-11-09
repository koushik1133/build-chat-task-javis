import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/dsql", () => ({ query: vi.fn(), withRetry: async <T,>(fn: () => Promise<T>) => fn() }));
import { MAX_BATCH, chunk, clampBatchSize, deleteInBatches, inBatches, insertInBatches, runBatchedStatement, updateInBatches } from "../batch";

describe("chunk / inBatches", () => {
  it("never exceeds the cap even when a larger size is requested", () => {
    expect(clampBatchSize(99999)).toBe(MAX_BATCH);
    expect(clampBatchSize(0)).toBe(1);
    const parts = chunk(Array.from({ length: 2500 }, (_, i) => i), 5000);
    expect(parts.map((p) => p.length)).toEqual([1000, 1000, 500]);
  });
  it("runs batches sequentially and returns results", async () => {
    const order: number[] = [];
    const res = await inBatches([1, 2, 3, 4, 5], 2, async (b, i) => { order.push(i); return b.length; });
    expect(res).toEqual([2, 2, 1]);
    expect(order).toEqual([0, 1, 2]);
  });
});

describe("deleteInBatches", () => {
  it("loops until a short batch and binds LIMIT after the caller params", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const sizes = [1000, 1000, 40];
    const run = vi.fn(async (sql: string, params: unknown[]) => { calls.push({ sql, params }); return Array.from({ length: sizes.shift() ?? 0 }, (_, i) => ({ id: String(i) })); });
    const n = await deleteInBatches("web_vitals", "created_at < $1", ["x"], 5000, { run });
    expect(n).toBe(2040);
    expect(calls).toHaveLength(3);
    expect(calls[0].sql).toContain("DELETE FROM web_vitals WHERE id IN (SELECT id FROM web_vitals WHERE created_at < $1 LIMIT $2)");
    expect(calls[0].params).toEqual(["x", 1000]);
  });
  it("stops at maxBatches and rejects bad identifiers", async () => {
    const run = vi.fn(async () => Array.from({ length: 10 }, (_, i) => ({ id: String(i) })));
    expect(await deleteInBatches("t", "a = $1", [1], 10, { run, maxBatches: 3 })).toBe(30);
    await expect(deleteInBatches("t; drop", "1=1", [], 10, { run })).rejects.toThrow(/invalid identifier/);
  });
  it("supports a non-id key column", async () => {
    const run = vi.fn<(s: string, p: unknown[]) => Promise<Array<{ id: string }>>>(async () => []);
    await deleteInBatches("rate_limits", "updated_at < $1", ["x"], 1000, { run, idColumn: "key" });
    expect(String(run.mock.calls[0][0])).toContain("WHERE key IN (SELECT key FROM rate_limits");
  });
});

describe("updateInBatches", () => {
  it("pages by primary key so still-matching rows are not revisited", async () => {
    const pages = [["a", "b"], ["c"]];
    const seen: unknown[][] = [];
    const run = vi.fn(async (_sql: string, params: unknown[]) => { seen.push(params); return (pages.shift() ?? []).map((id) => ({ id })); });
    const n = await updateInBatches("tasks", "milestone_id = NULL", "user_id = $1", ["u"], [], 2, { run });
    expect(n).toBe(3);
    expect(seen[0]).toEqual(["u", "", 2]);
    expect(seen[1]).toEqual(["u", "b", 2]);
    expect(String(run.mock.calls[0][0])).toContain("id::text > $2 ORDER BY id::text LIMIT $3");
  });
});

describe("runBatchedStatement", () => {
  it("rewrites simple DELETE/UPDATE and leaves other shapes alone", async () => {
    const run = vi.fn(async () => []);
    expect(await runBatchedStatement("DELETE FROM a WHERE user_id = $1", ["u"], 1000, { run })).toBe(0);
    expect(await runBatchedStatement("UPDATE a SET x = $2 WHERE user_id = $1", ["u", 1], 1000, { run })).toBe(0);
    expect(run).toHaveBeenCalledTimes(2);
    expect(await runBatchedStatement("UPDATE a SET x = 1 WHERE id = $1 RETURNING id", ["u"], 1000, { run })).toBeNull();
    expect(await runBatchedStatement("INSERT INTO a VALUES (1)", [], 1000, { run })).toBeNull();
  });
});

describe("insertInBatches", () => {
  it("emits multi-row inserts of at most `size` rows", async () => {
    const exec = vi.fn(async () => undefined);
    const rows = Array.from({ length: 450 }, (_, i) => [`id${i}`, i]);
    expect(await insertInBatches("t", ["id", "n"], rows, 200, "ON CONFLICT DO NOTHING", exec)).toBe(450);
    expect(exec).toHaveBeenCalledTimes(3);
    const first = exec.mock.calls[0] as unknown as [string, unknown[]];
    expect(first[1]).toHaveLength(400);
    expect(first[0]).toMatch(/^INSERT INTO t \(id, n\) VALUES \(\$1, \$2\), \(\$3, \$4\)/);
    expect(first[0]).toMatch(/ON CONFLICT DO NOTHING$/);
  });
});
