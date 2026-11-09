import { describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  query: vi.fn<(sql: string, values?: unknown[]) => Promise<unknown[]>>(),
  withRetry: vi.fn(async <T,>(fn: () => Promise<T>) => fn()),
}));
vi.mock("@/lib/dsql", () => db);
import { captureError, errorFingerprint, normaliseError, STACK_MAX_CHARS } from "@/lib/errors/capture";

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
});
