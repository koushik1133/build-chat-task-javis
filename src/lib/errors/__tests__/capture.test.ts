import { describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  query: vi.fn<(sql: string, values?: unknown[]) => Promise<unknown[]>>(),
  withRetry: vi.fn(async <T,>(fn: () => Promise<T>) => fn()),
}));
vi.mock("@/lib/dsql", () => db);
import { captureError, errorFingerprint, listRecentErrors, normaliseError, STACK_MAX_CHARS } from "@/lib/errors/capture";

describe("captureError", () => {
  it("fingerprints on route + first message line only", () => {
    expect(errorFingerprint("/api/v1/x", "boom\nat line 1")).toBe(errorFingerprint("/api/v1/x", "boom\nat line 99"));
    expect(errorFingerprint("/api/v1/x", "boom")).not.toBe(errorFingerprint("/api/v1/y", "boom"));
  });
  it("trims stacks to 4k and handles non-Error values", () => {
    const e = new Error("x");
    e.stack = "y".repeat(10_000);
    expect(normaliseError(e).stack?.length).toBe(STACK_MAX_CHARS);
    expect(normaliseError("plain").message).toBe("plain");
    expect(normaliseError({ a: 1 }).message).toBe('{"a":1}');
  });
  it("increments an existing fingerprint, inserts otherwise", async () => {
    db.query.mockResolvedValueOnce([{ id: "e1" }]);
    expect(await captureError(new Error("dup"), { route: "/r", method: "GET", status: 500 })).toBe("e1");
    db.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const id = await captureError(new Error("new"), { route: "/r", method: "GET", status: 500, userId: "u1" });
    expect(id).toMatch(/[0-9a-f-]{36}/);
    expect(String(db.query.mock.calls.at(-1)?.[0])).toMatch(/INSERT INTO app_errors/);
  });
  it("never throws when the database is unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    db.query.mockRejectedValue(new Error("down"));
    await expect(captureError(new Error("x"), { route: "/r" })).resolves.toBeNull();
    warn.mockRestore();
  });
  it("SEC: fingerprints are tenant-separated so one org cannot pre-claim or inflate another org's row", () => {
    expect(errorFingerprint("/r", "boom", "org-a")).not.toBe(errorFingerprint("/r", "boom", "org-b"));
    expect(errorFingerprint("/r", "boom", "org-a")).not.toBe(errorFingerprint("/r", "boom", null));
    expect(errorFingerprint("/r", "boom", "org-a")).toBe(errorFingerprint("/r", "boom\nstack", "org-a"));
  });
  it("SEC: captureError folds the owner into the fingerprint lookup", async () => {
    db.query.mockReset();
    db.query.mockResolvedValueOnce([{ id: "e2" }]);
    await captureError(new Error("same"), { route: "/r", userId: "org-a" });
    const fp = db.query.mock.calls[0]?.[1]?.[0];
    expect(fp).toBe(errorFingerprint("/r", "same", "org-a"));
  });
  it("SEC: listRecentErrors is scoped to the caller's workspace and never returns anonymous rows", async () => {
    db.query.mockReset();
    db.query.mockResolvedValueOnce([]);
    await listRecentErrors(50, "org-a");
    const [sql, params] = db.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/WHERE user_id = \$2/);
    expect(params[1]).toBe("org-a");
    expect(await listRecentErrors(50, "")).toEqual([]);
  });
});

describe("captureError concurrency", () => {
  it("folds a lost INSERT race into the winning row instead of dropping the occurrence", async () => {
    db.query.mockReset();
    db.query
      .mockResolvedValueOnce([]) // first UPDATE: no row yet
      .mockRejectedValueOnce(new Error("duplicate key value violates unique constraint idx_app_errors_fingerprint"))
      .mockResolvedValueOnce([{ id: "winner" }]); // follow-up UPDATE
    expect(await captureError(new Error("race"), { route: "/r", userId: "org-a" })).toBe("winner");
    expect(String(db.query.mock.calls[2][0])).toMatch(/count = count \+ 1/);
  });
});
