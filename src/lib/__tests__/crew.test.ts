import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const queryOne = vi.fn();
vi.mock("@/lib/dsql", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
  withRetry: (fn: () => unknown) => fn(),
}));
vi.mock("@/lib/share-tokens", () => ({ resolveShareToken: vi.fn() }));
vi.mock("@/lib/table-exists", () => ({ tableExists: async () => true }));

import { CREW_REF_KIND, CrewActionError, runCrewAction } from "@/lib/crew";

const token = {
  id: "tok1", user_id: "org", kind: "crew", entity_id: "org-row", token_hash: "", expires_at: null, created_at: "", label: "Night crew",
} as unknown as Parameters<typeof runCrewAction>[0];

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
});

/** Columns that exist on time_entries per aws/migrations.sql. */
const TIME_ENTRY_COLUMNS = ["id", "user_id", "member_id", "ref_kind", "ref_id", "description", "started_at", "ended_at", "minutes", "rate_minor", "currency", "billable", "invoice_id", "created_at"];

function insertedColumns(sql: string): string[] {
  const m = sql.match(/INSERT INTO time_entries \(([^)]+)\)/);
  return (m?.[1] ?? "").split(",").map((s) => s.trim());
}

describe("crew clock in / out", () => {
  it("clock_in writes only real time_entries columns, keyed by ref_kind/ref_id, with a conditional INSERT", async () => {
    query.mockResolvedValue([{ id: "e1" }]);
    const out = await runCrewAction(token, { action: "clock_in" });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    const cols = insertedColumns(sql);
    expect(cols.length).toBeGreaterThan(0);
    for (const c of cols) expect(TIME_ENTRY_COLUMNS, `unknown column ${c}`).toContain(c);
    expect(sql).not.toMatch(/crew_token_id|label|source/);
    expect(sql).toContain("WHERE NOT EXISTS");
    expect(params[2]).toBe(CREW_REF_KIND);
    expect(params[3]).toBe("tok1");
    expect(out).toMatchObject({ entryId: expect.any(String), startedAt: expect.any(String) });
  });

  it("clock_in is refused when a crew timer is already open", async () => {
    query.mockResolvedValue([]);
    await expect(runCrewAction(token, { action: "clock_in" })).rejects.toMatchObject({ status: 409 });
  });

  it("clock_out closes the open entry by ref and fills minutes", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.startsWith("UPDATE time_entries SET ended_at")) {
        expect(sql).toContain("ref_kind = $2 AND ref_id = $3 AND ended_at IS NULL");
        return [{ id: "e1", started_at: "2026-01-01T09:00:00Z", ended_at: "2026-01-01T09:45:00Z" }];
      }
      return [];
    });
    const out = await runCrewAction(token, { action: "clock_out" });
    expect(out).toEqual({ entryId: "e1", startedAt: "2026-01-01T09:00:00.000Z", endedAt: "2026-01-01T09:45:00.000Z" });
    const minutesUpd = query.mock.calls.find(([s]) => String(s).includes("SET minutes = $3")) as [string, unknown[]];
    expect(minutesUpd[1]).toEqual(["e1", "org", 45]);
  });

  it("clock_out without an open entry is a 409, and a DB failure is a 501 rather than a crash", async () => {
    query.mockResolvedValue([]);
    await expect(runCrewAction(token, { action: "clock_out" })).rejects.toBeInstanceOf(CrewActionError);
    query.mockRejectedValue(new Error('column "nope" does not exist'));
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(runCrewAction(token, { action: "clock_in" })).rejects.toMatchObject({ status: 501 });
    spy.mockRestore();
  });
});
