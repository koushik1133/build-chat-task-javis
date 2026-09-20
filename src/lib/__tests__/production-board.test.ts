import { describe, expect, it } from "vitest";
import {
  colById,
  nextColumn,
  parseBoardColumns,
  shouldFireAutomations,
  sortByPriority,
  validateMove,
  type BoardColumn,
} from "@/lib/production-board";

const cols: BoardColumn[] = [
  { id: "todo", label: "To Do", hitl: false, color: "gray" },
  { id: "review", label: "Review", hitl: true, color: "amber" },
  { id: "build", label: "Build", hitl: false, color: "blue" },
  { id: "done", label: "Done", hitl: false, color: "green" },
];

describe("parseBoardColumns", () => {
  it("passes arrays through untouched", () => {
    expect(parseBoardColumns(cols)).toBe(cols);
  });

  it("parses a JSON string", () => {
    expect(parseBoardColumns(JSON.stringify(cols))).toEqual(cols);
  });

  it("returns [] for malformed JSON", () => {
    expect(parseBoardColumns("{not json")).toEqual([]);
  });

  it("returns [] for null, undefined, numbers and objects", () => {
    expect(parseBoardColumns(null)).toEqual([]);
    expect(parseBoardColumns(undefined)).toEqual([]);
    expect(parseBoardColumns(42)).toEqual([]);
    expect(parseBoardColumns({ id: "x" })).toEqual([]);
  });
});

describe("colById", () => {
  it("finds a column by id", () => {
    expect(colById(cols, "review")).toEqual(cols[1]);
  });

  it("returns undefined for an unknown id", () => {
    expect(colById(cols, "nope")).toBeUndefined();
  });
});

describe("validateMove", () => {
  it("allows a no-op move to the same column, even a HITL one", () => {
    expect(validateMove(cols, "review", "review")).toEqual({ ok: true });
  });

  it("allows moves out of non-HITL columns", () => {
    expect(validateMove(cols, "todo", "build")).toEqual({ ok: true });
    expect(validateMove(cols, "build", "done")).toEqual({ ok: true });
  });

  it("allows moving into a HITL column", () => {
    expect(validateMove(cols, "todo", "review")).toEqual({ ok: true });
  });

  it("rejects dragging out of a HITL gate with the column label in the reason", () => {
    const res = validateMove(cols, "review", "build");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain('"Review"');
      expect(res.reason).toMatch(/HITL gate/);
    }
  });

  it("rejects unknown source or target columns", () => {
    expect(validateMove(cols, "ghost", "build")).toEqual({ ok: false, reason: "Unknown column." });
    expect(validateMove(cols, "todo", "ghost")).toEqual({ ok: false, reason: "Unknown column." });
  });
});

describe("shouldFireAutomations", () => {
  it("never fires for a same-column move", () => {
    expect(shouldFireAutomations(cols, "todo", "todo", false)).toBe(false);
    expect(shouldFireAutomations(cols, "review", "review", true)).toBe(false);
  });

  it("never fires for unknown columns", () => {
    expect(shouldFireAutomations(cols, "ghost", "build", true)).toBe(false);
    expect(shouldFireAutomations(cols, "todo", "ghost", true)).toBe(false);
  });

  it("never fires when entering a HITL column", () => {
    expect(shouldFireAutomations(cols, "todo", "review", false)).toBe(false);
    expect(shouldFireAutomations(cols, "todo", "review", true)).toBe(false);
  });

  it("fires on leaving a HITL column only via approval", () => {
    expect(shouldFireAutomations(cols, "review", "build", true)).toBe(true);
    expect(shouldFireAutomations(cols, "review", "build", false)).toBe(false);
  });

  it("fires for ordinary non-HITL to non-HITL moves", () => {
    expect(shouldFireAutomations(cols, "todo", "build", false)).toBe(true);
    expect(shouldFireAutomations(cols, "build", "done", false)).toBe(true);
  });
});

describe("nextColumn", () => {
  it("returns the following column", () => {
    expect(nextColumn(cols, "todo")).toEqual(cols[1]);
    expect(nextColumn(cols, "build")).toEqual(cols[3]);
  });

  it("returns null for the last column", () => {
    expect(nextColumn(cols, "done")).toBeNull();
  });

  it("returns null for an unknown column", () => {
    expect(nextColumn(cols, "ghost")).toBeNull();
  });

  it("returns null for an empty board", () => {
    expect(nextColumn([], "todo")).toBeNull();
  });
});

describe("sortByPriority", () => {
  it("orders high, medium, low", () => {
    const items = [
      { id: 1, priority: "low" },
      { id: 2, priority: "high" },
      { id: 3, priority: "medium" },
      { id: 4, priority: "high" },
    ];
    expect(sortByPriority(items).map((i) => i.id)).toEqual([2, 4, 3, 1]);
  });

  it("is stable within the same priority", () => {
    const items = [
      { id: "a", priority: "medium" },
      { id: "b", priority: "medium" },
      { id: "c", priority: "medium" },
    ];
    expect(sortByPriority(items).map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("treats unknown priorities as medium", () => {
    const items = [
      { id: 1, priority: "low" },
      { id: 2, priority: "urgent" },
      { id: 3, priority: "high" },
      { id: 4, priority: "medium" },
    ];
    expect(sortByPriority(items).map((i) => i.id)).toEqual([3, 2, 4, 1]);
  });

  it("does not mutate the input array", () => {
    const items = [{ priority: "low" }, { priority: "high" }];
    const copy = [...items];
    sortByPriority(items);
    expect(items).toEqual(copy);
  });
});
