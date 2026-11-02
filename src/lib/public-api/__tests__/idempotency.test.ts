import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn() }));
vi.mock("@/lib/dsql", () => ({ query: mocks.query, queryOne: mocks.queryOne }));

import { ApiError } from "@/lib/public-api/envelope";
import { IDEMPOTENCY_TTL_MS, isValidIdempotencyKey, requestHash, withIdempotency } from "@/lib/public-api/idempotency";

beforeEach(() => {
  mocks.query.mockReset();
  mocks.queryOne.mockReset();
  mocks.query.mockResolvedValue([]);
});

describe("requestHash / key validation", () => {
  it("hashes method+path+body deterministically", () => {
    expect(requestHash("post", "/api/v1/contacts", "{}")).toBe(requestHash("POST", "/api/v1/contacts", "{}"));
    expect(requestHash("POST", "/api/v1/contacts", "{}")).not.toBe(requestHash("POST", "/api/v1/contacts", "{\"a\":1}"));
  });
  it("accepts reasonable keys only", () => {
    expect(isValidIdempotencyKey("abc-123")).toBe(true);
    expect(isValidIdempotencyKey("")).toBe(false);
    expect(isValidIdempotencyKey("has space")).toBe(false);
    expect(isValidIdempotencyKey("x".repeat(256))).toBe(false);
  });
});

describe("withIdempotency", () => {
  it("runs once and stores the response", async () => {
    mocks.queryOne.mockResolvedValueOnce(null);
    const fn = vi.fn(async () => ({ status: 201, body: { data: { id: "c1" }, meta: {} } }));
    const out = await withIdempotency("u", "k1", "h1", fn);
    expect(out).toMatchObject({ status: 201, replayed: false });
    expect(fn).toHaveBeenCalledTimes(1);
    const insert = mocks.query.mock.calls.find((c) => String(c[0]).includes("INSERT INTO api_idempotency"));
    expect(insert?.[1]).toEqual(["u", "k1", "h1"]);
    const update = mocks.query.mock.calls.find((c) => String(c[0]).includes("status = 'completed'"));
    expect(JSON.parse(update?.[1][2] as string)).toEqual({ status: 201, body: { data: { id: "c1" }, meta: {} } });
  });

  it("replays a completed request with the same hash", async () => {
    mocks.queryOne.mockResolvedValueOnce({
      id: "row",
      request_hash: "h1",
      status: "completed",
      response_json: JSON.stringify({ status: 201, body: { data: { id: "c1" } } }),
      created_at: new Date().toISOString(),
    });
    const fn = vi.fn();
    const out = await withIdempotency("u", "k1", "h1", fn);
    expect(out).toEqual({ status: 201, body: { data: { id: "c1" } }, replayed: true });
    expect(fn).not.toHaveBeenCalled();
  });

  it("rejects the same key with a different body", async () => {
    mocks.queryOne.mockResolvedValueOnce({ id: "row", request_hash: "other", status: "completed", response_json: "{}", created_at: new Date().toISOString() });
    await expect(withIdempotency("u", "k1", "h1", vi.fn())).rejects.toMatchObject({ status: 422, code: "idempotency_mismatch" } satisfies Partial<ApiError>);
  });

  it("treats an in-flight key as a conflict", async () => {
    mocks.queryOne.mockResolvedValueOnce({ id: "row", request_hash: "h1", status: "pending", response_json: null, created_at: new Date().toISOString() });
    await expect(withIdempotency("u", "k1", "h1", vi.fn())).rejects.toMatchObject({ status: 409, code: "idempotency_in_progress" });
  });

  it("ignores and deletes expired rows, then runs again", async () => {
    mocks.queryOne.mockResolvedValueOnce({ id: "old", request_hash: "h1", status: "completed", response_json: "{}", created_at: new Date(Date.now() - IDEMPOTENCY_TTL_MS - 1000).toISOString() });
    const fn = vi.fn(async () => ({ status: 200, body: { ok: true } }));
    const out = await withIdempotency("u", "k1", "h1", fn);
    expect(out.replayed).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls.some((c) => String(c[0]).startsWith("DELETE FROM api_idempotency WHERE id"))).toBe(true);
  });

  it("releases the key when the handler throws so the client can retry", async () => {
    mocks.queryOne.mockResolvedValueOnce(null);
    await expect(withIdempotency("u", "k1", "h1", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(mocks.query.mock.calls.some((c) => String(c[0]).includes("DELETE FROM api_idempotency WHERE user_id"))).toBe(true);
  });
});
