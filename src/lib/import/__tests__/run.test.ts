import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("@/lib/dsql", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: vi.fn(),
  withRetry: (fn: () => unknown) => fn(),
}));
vi.mock("@/lib/table-exists", () => ({ tableExists: async () => true }));

import { dedupeKeyFor, runImport } from "@/lib/import/run";
import { IMPORT_TARGETS, expenseDedupeKey, isoDay, type ImportTarget, type NormalisedRow } from "@/lib/import/targets";

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue([]);
});

function fakeTarget(over: Partial<ImportTarget> = {}): ImportTarget {
  return {
    key: "tasks",
    label: "Tasks",
    description: "",
    table: "tasks",
    area: "tasks",
    dedupeKey: ["title"],
    fields: [{ key: "title", label: "Title", type: "string", required: true, synonyms: [] }],
    existingKeys: async () => new Set<string>(),
    insert: async () => undefined,
    ...over,
  };
}

describe("runImport", () => {
  it("reports insert failures against the original CSV row number, not the index among valid rows", async () => {
    const inserted: string[] = [];
    const target = fakeTarget({
      existingKeys: async () => new Set(["dup"]),
      insert: async (_dataId, rows: NormalisedRow[]) => {
        if (rows.length > 1) throw new Error("chunk failed");
        const title = String(rows[0].title);
        if (title === "boom") throw new Error("row is bad");
        inserted.push(title);
      },
    });
    const rows = [
      ["dup"], // row 1: duplicate of existing → skipped before insert
      [""], // row 2: required missing → skipped
      ["ok-a"], // row 3
      ["boom"], // row 4: insert fails
      ["ok-b"], // row 5
    ];
    const res = await runImport("org", target, ["Title"], rows, { title: "Title" }, { recordJob: false });
    expect(inserted).toEqual(["ok-a", "ok-b"]);
    expect(res.inserted).toBe(2);
    expect(res.skipped).toBe(3);
    const insertErr = res.errors.find((e) => e.message.startsWith("Insert failed"));
    expect(insertErr?.row).toBe(4);
    expect(res.errors.map((e) => e.row)).toEqual([1, 2, 4]);
  });

  it("dedupes within the file and against existing rows", async () => {
    const seen: string[] = [];
    const target = fakeTarget({
      existingKeys: async () => new Set(["existing"]),
      insert: async (_d, rows: NormalisedRow[]) => {
        seen.push(...rows.map((r) => String(r.title)));
      },
    });
    const res = await runImport("org", target, ["Title"], [["New"], ["new"], ["Existing"], ["Other"]], { title: "Title" }, { recordJob: false });
    expect(seen).toEqual(["New", "Other"]);
    expect(res.skipped).toBe(2);
    expect(res.errors.map((e) => e.message)).toEqual([
      "Duplicate within the file (title).",
      "Duplicate of an existing record (title).",
    ]);
  });

  it("dry run writes nothing to the target and records the job flagged dry_run", async () => {
    const insert = vi.fn(async () => undefined);
    const target = fakeTarget({ insert });
    const res = await runImport("org", target, ["Title"], [["A"], ["B"]], { title: "Title" }, { dryRun: true });
    expect(insert).not.toHaveBeenCalled();
    expect(res).toMatchObject({ inserted: 2, skipped: 0, dryRun: true });
    expect(res.jobId).toMatch(/[0-9a-f-]{36}/);
    const [sql, values] = query.mock.calls.find(([s]) => String(s).includes("INSERT INTO import_jobs")) as [string, unknown[]];
    expect(sql).toContain("import_jobs");
    expect(values[4]).toBe("dry_run"); // status
    expect(values[5]).toBe(true); // dry_run flag
    expect(query.mock.calls.filter(([s]) => !String(s).includes("import_jobs"))).toHaveLength(0);
  });
});

describe("expenses target", () => {
  it("never inserts NULL into expenses.category (NOT NULL DEFAULT 'general')", async () => {
    await IMPORT_TARGETS.expenses.insert("org", [{ spent_at: "2024-03-01", amount_minor: 450, vendor: "Shop", category: null, description: null, currency: null }]);
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO expenses");
    expect(values[2]).toBe("general");
  });

  it("existing keys match the import dedupe key when pg returns spent_at as a Date", async () => {
    const spent = new Date("2024-03-01T00:00:00Z");
    query.mockResolvedValue([{ vendor: "Shop", amount_minor: "450", spent_at: spent }]);
    const existing = await IMPORT_TARGETS.expenses.existingKeys("org");
    const incoming = dedupeKeyFor({ vendor: "Shop", amount_minor: 450, spent_at: "2024-03-01" }, IMPORT_TARGETS.expenses);
    expect(incoming).toBe("shop|450|2024-03-01");
    expect(existing.has(incoming!)).toBe(true);
    // Sanity: the old String(Date).slice(0, 10) form would have produced "Fri Mar 01".
    expect(expenseDedupeKey("Shop", "450", spent)).toBe("shop|450|2024-03-01");
    expect(isoDay("2024-03-01T12:00:00Z")).toBe("2024-03-01");
    expect(isoDay(null)).toBe("");
  });
});
