import { describe, expect, it, vi } from "vitest";
import { columnsOfVia, tableExistsVia, type CatalogQuery } from "../catalog";

const fake = (handler: (sql: string, params?: unknown[]) => unknown[] | Error): CatalogQuery =>
  (async (sql: string, params?: unknown[]) => { const r = handler(sql, params); if (r instanceof Error) throw r; return r; }) as CatalogQuery;

describe("tableExistsVia", () => {
  it("uses information_schema first", async () => {
    const fn = vi.fn<(s: string) => unknown[]>(() => [{ n: "t" }]);
    const q = fake((s) => fn(s));
    expect(await tableExistsVia(q, "t")).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("falls back to to_regclass when information_schema errors", async () => {
    const q = fake((sql) => (sql.includes("information_schema") ? new Error("permission denied") : [{ ok: true }]));
    expect(await tableExistsVia(q, "t")).toBe(true);
  });
  it("falls back to to_regclass when information_schema is empty (limited view)", async () => {
    const q = fake((sql) => (sql.includes("information_schema") ? [] : [{ ok: true }]));
    expect(await tableExistsVia(q, "t")).toBe(true);
  });
  it("falls back to pg_tables when to_regclass is unavailable, and is false when everything fails", async () => {
    const q = fake((sql) => (sql.includes("pg_tables") ? [{ n: "t" }] : new Error("nope")));
    expect(await tableExistsVia(q, "t")).toBe(true);
    expect(await tableExistsVia(fake(() => new Error("nope")), "t")).toBe(false);
    expect(await tableExistsVia(fake(() => []), "t")).toBe(false);
  });
  it("rejects invalid identifiers without querying", async () => {
    const fn = vi.fn<(s: string) => unknown[]>(() => []);
    expect(await tableExistsVia(fake((s) => fn(s)), "a;b")).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("columnsOfVia", () => {
  it("groups columns by table from information_schema", async () => {
    const q = fake(() => [{ table_name: "a", column_name: "id" }, { table_name: "a", column_name: "user_id" }, { table_name: "b", column_name: "id" }]);
    const m = await columnsOfVia(q, ["a", "b"]);
    expect(m.get("a")).toEqual(["id", "user_id"]);
    expect(m.get("b")).toEqual(["id"]);
  });
  it("falls back to pg_catalog when information_schema errors or is empty", async () => {
    for (const first of [new Error("denied"), [] as unknown[]]) {
      const q = fake((sql) => (sql.includes("information_schema") ? (first as unknown[] | Error) : [{ table_name: "a", column_name: "id" }]));
      expect((await columnsOfVia(q, ["a"])).get("a")).toEqual(["id"]);
    }
  });
  it("throws only when both sources fail", async () => {
    await expect(columnsOfVia(fake(() => new Error("boom")), ["a"])).rejects.toThrow("boom");
  });
});
