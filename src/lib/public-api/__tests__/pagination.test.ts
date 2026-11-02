import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, keysetClause, keysetOrder, page, parseListParams, MAX_LIMIT } from "@/lib/public-api/pagination";

describe("cursor encoding", () => {
  it("round-trips created_at + id", () => {
    const c = { created_at: "2026-11-02T10:00:00.000Z", id: "abc-123" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });
  it("rejects garbage", () => {
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor("!!!")).toBeNull();
    expect(decodeCursor(Buffer.from("no-separator").toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from("not-a-date|id").toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from("2026-01-01T00:00:00Z|").toString("base64url"))).toBeNull();
  });
});

describe("parseListParams", () => {
  it("defaults and clamps limit", () => {
    expect(parseListParams("http://x/api/v1/contacts").limit).toBe(50);
    expect(parseListParams("http://x/api/v1/contacts?limit=5").limit).toBe(5);
    expect(parseListParams("http://x/api/v1/contacts?limit=99999").limit).toBe(MAX_LIMIT);
    expect(parseListParams("http://x/api/v1/contacts?limit=-3").limit).toBe(50);
    expect(parseListParams("http://x/api/v1/contacts?limit=abc").limit).toBe(50);
  });
  it("flags undecodable cursors", () => {
    const bad = parseListParams("http://x/api/v1/contacts?cursor=%2A%2A");
    expect(bad.cursor).toBeNull();
    expect(bad.badCursor).toBe(true);
    const good = parseListParams(`http://x/api/v1/contacts?cursor=${encodeCursor({ created_at: "2026-01-01T00:00:00.000Z", id: "1" })}`);
    expect(good.badCursor).toBe(false);
    expect(good.cursor?.id).toBe("1");
  });
  it("trims q", () => {
    expect(parseListParams("http://x/?q=%20ada%20").q).toBe("ada");
    expect(parseListParams("http://x/?q=").q).toBeNull();
  });
});

describe("keyset SQL", () => {
  it("appends a tuple predicate with two params", () => {
    const params: unknown[] = ["user"];
    const sql = keysetClause({ created_at: "2026-01-01T00:00:00.000Z", id: "z" }, params, { alias: "q." });
    expect(sql).toBe(" AND (q.created_at < $2 OR (q.created_at = $2 AND q.id::text < $3))");
    expect(params).toEqual(["user", "2026-01-01T00:00:00.000Z", "z"]);
    expect(keysetClause(null, params)).toBe("");
    expect(params).toHaveLength(3);
    expect(keysetOrder("t.")).toBe("t.created_at DESC, t.id DESC");
  });
});

describe("page", () => {
  const rows = Array.from({ length: 4 }, (_, i) => ({ id: `r${i}`, created_at: new Date(2026, 0, 10 - i) }));
  it("trims to limit and emits a cursor for the last returned row", () => {
    const p = page(rows, 3, (r) => ({ created_at: r.created_at.toISOString(), id: r.id }));
    expect(p.data.map((r) => r.id)).toEqual(["r0", "r1", "r2"]);
    expect(decodeCursor(p.next_cursor!)).toEqual({ created_at: rows[2].created_at.toISOString(), id: "r2" });
  });
  it("has no cursor when the page is not full", () => {
    const p = page(rows.slice(0, 2), 3, (r) => ({ created_at: r.created_at.toISOString(), id: r.id }));
    expect(p.data).toHaveLength(2);
    expect(p.next_cursor).toBeNull();
  });
});
