import { describe, expect, it } from "vitest";
import { evaluateConditions, getPath, listPaths } from "@/lib/automations/conditions";
import type { RunContext } from "@/lib/automations/types";

const ctx: RunContext = {
  event: { id: "e1", type: "invoice.paid", entity: "invoice", entity_id: "i1", data: { total_minor: 12500, currency: "USD", tags: ["vip", "net30"], from: "sent", to: "paid", nested: { a: { b: 1 } } }, created_at: "2026-01-01T00:00:00Z" },
  entity: { status: "paid", customer_email: "ada@example.com", due_at: "2026-01-10T00:00:00Z" },
  org: { id: "org1", name: "Acme" },
  automation: { id: "a1", name: "Test" },
  steps: { enrich: { score: 80 } },
  now: "2026-01-05T00:00:00Z",
};

describe("getPath", () => {
  it("resolves dotted paths, arrays and missing segments", () => {
    expect(getPath(ctx, "event.data.total_minor")).toBe(12500);
    expect(getPath(ctx, "event.data.tags.0")).toBe("vip");
    expect(getPath(ctx, "event.data.nested.a.b")).toBe(1);
    expect(getPath(ctx, "entity.missing.deep")).toBeUndefined();
    expect(getPath(ctx, "nope")).toBeUndefined();
    expect(getPath(ctx, "steps.enrich.score")).toBe(80);
  });
});

describe("evaluateConditions ops", () => {
  const rule = (field: string, op: string, value?: unknown) => evaluateConditions({ field, op: op as "eq", value }, ctx);
  it("eq / neq are loose and case-insensitive for strings", () => {
    expect(rule("entity.status", "eq", "paid")).toBe(true);
    expect(rule("entity.status", "eq", "PAID")).toBe(true);
    expect(rule("event.data.total_minor", "eq", "12500")).toBe(true);
    expect(rule("entity.status", "neq", "draft")).toBe(true);
    expect(rule("entity.nothing", "eq", "x")).toBe(false);
    expect(rule("entity.nothing", "neq", "x")).toBe(true);
  });
  it("contains works on strings, arrays and objects", () => {
    expect(rule("entity.customer_email", "contains", "@example")).toBe(true);
    expect(rule("event.data.tags", "contains", "vip")).toBe(true);
    expect(rule("event.data.tags", "contains", "nope")).toBe(false);
    expect(rule("event.data.nested", "contains", "a")).toBe(true);
    expect(rule("entity.nothing", "contains", "a")).toBe(false);
  });
  it("gt/gte/lt/lte compare numbers, numeric strings and dates", () => {
    expect(rule("event.data.total_minor", "gt", 10000)).toBe(true);
    expect(rule("event.data.total_minor", "gte", 12500)).toBe(true);
    expect(rule("event.data.total_minor", "lt", 12500)).toBe(false);
    expect(rule("event.data.total_minor", "lte", "12500")).toBe(true);
    expect(rule("entity.due_at", "gt", "2026-01-01")).toBe(true);
    expect(rule("entity.status", "gt", 5)).toBe(false);
    expect(rule("entity.nothing", "gt", 1)).toBe(false);
  });
  it("in accepts arrays and comma lists", () => {
    expect(rule("entity.status", "in", ["draft", "paid"])).toBe(true);
    expect(rule("entity.status", "in", "draft, paid")).toBe(true);
    expect(rule("entity.status", "in", ["draft"])).toBe(false);
  });
  it("exists honours value=false", () => {
    expect(rule("entity.status", "exists")).toBe(true);
    expect(rule("entity.nothing", "exists")).toBe(false);
    expect(rule("entity.nothing", "exists", false)).toBe(true);
  });
  it("changed_to requires the new value and a different previous value", () => {
    expect(rule("event.data.to", "changed_to", "paid")).toBe(true);
    expect(rule("event.data.to", "changed_to", "sent")).toBe(false);
    const same = { ...ctx, event: { ...ctx.event, data: { ...ctx.event.data, from: "paid" } } };
    expect(evaluateConditions({ field: "event.data.to", op: "changed_to", value: "paid" }, same)).toBe(false);
  });
  it("unknown op is false", () => {
    expect(rule("entity.status", "regex", ".*")).toBe(false);
  });
});

describe("evaluateConditions groups", () => {
  it("null / empty groups are true", () => {
    expect(evaluateConditions(null, ctx)).toBe(true);
    expect(evaluateConditions({ all: [] }, ctx)).toBe(true);
    expect(evaluateConditions({ any: [] }, ctx)).toBe(true);
  });
  it("all = AND, any = OR, nested", () => {
    expect(evaluateConditions({ all: [{ field: "entity.status", op: "eq", value: "paid" }, { field: "event.data.total_minor", op: "gt", value: 1 }] }, ctx)).toBe(true);
    expect(evaluateConditions({ all: [{ field: "entity.status", op: "eq", value: "paid" }, { field: "event.data.total_minor", op: "gt", value: 99999 }] }, ctx)).toBe(false);
    expect(evaluateConditions({ any: [{ field: "entity.status", op: "eq", value: "draft" }, { field: "event.data.currency", op: "eq", value: "USD" }] }, ctx)).toBe(true);
    expect(evaluateConditions({ all: [{ field: "org.id", op: "exists" }], any: [{ field: "entity.status", op: "eq", value: "draft" }, { any: [{ field: "steps.enrich.score", op: "gte", value: 80 }] }] }, ctx)).toBe(true);
  });
});

describe("listPaths", () => {
  it("flattens leaf paths with a prefix", () => {
    expect(listPaths(ctx.event.data, "event.data")).toEqual(expect.arrayContaining(["event.data.total_minor", "event.data.tags", "event.data.nested.a.b"]));
  });
});
