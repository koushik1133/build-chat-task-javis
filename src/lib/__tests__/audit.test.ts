import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/dsql", () => ({
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
  withRetry: async <T,>(fn: () => Promise<T>) => fn(),
}));

import { diffRecords, recordAudit } from "@/lib/audit";
import { query } from "@/lib/dsql";

describe("diffRecords", () => {
  it("reports added fields as [undefined, value]", () => {
    expect(diffRecords({ a: 1 }, { a: 1, b: "x" })).toEqual({ b: [undefined, "x"] });
  });

  it("reports removed fields as [value, undefined]", () => {
    expect(diffRecords({ a: 1, b: 2 }, { a: 1 })).toEqual({ b: [2, undefined] });
  });

  it("reports changed fields as [old, new]", () => {
    expect(diffRecords({ name: "Ada", stage: "lead" }, { name: "Ada", stage: "won" })).toEqual({ stage: ["lead", "won"] });
  });

  it("treats a JSON string and an equivalent object (any key order) as equal", () => {
    const before = { tags: '{"a":1,"b":[1,2]}' };
    const after = { tags: { b: [1, 2], a: 1 } };
    expect(diffRecords(before, after)).toEqual({});
    expect(diffRecords({ tags: '{"a":1}' }, { tags: '{"a":2}' })).toEqual({ tags: ['{"a":1}', '{"a":2}'] });
  });

  it("skips fields in the ignore list", () => {
    expect(diffRecords({ a: 1, updated_at: "t1" }, { a: 2, updated_at: "t2" }, { ignore: ["updated_at"] }))
      .toEqual({ a: [1, 2] });
  });

  it("handles null / undefined records", () => {
    expect(diffRecords(null, { a: 1 })).toEqual({ a: [undefined, 1] });
    expect(diffRecords({ a: 1 }, undefined)).toEqual({ a: [1, undefined] });
    expect(diffRecords(null, null)).toEqual({});
  });
});

describe("recordAudit", () => {
  it("writes a row with a JSON diff and never throws", async () => {
    const id = await recordAudit(
      { dataId: "org", userId: "u1", email: "a@b.c" },
      { action: "update", entity: "crm_contacts", entityId: "c1", before: { stage: "lead" }, after: { stage: "won" } }
    );
    expect(id).toBeTruthy();
    const call = vi.mocked(query).mock.calls.at(-1);
    expect(call?.[0]).toContain("INSERT INTO audit_log");
    const values = call?.[1] as unknown[];
    expect(values[1]).toBe("org");
    expect(values[2]).toBe("u1");
    expect(JSON.parse(String(values[7]))).toEqual({ stage: ["lead", "won"] });
  });

  it("returns null instead of throwing when the insert fails", async () => {
    vi.mocked(query).mockRejectedValueOnce(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const id = await recordAudit({ dataId: "org" }, { action: "delete", entity: "tasks", entityId: "t1" });
    expect(id).toBeNull();
    spy.mockRestore();
  });
});
