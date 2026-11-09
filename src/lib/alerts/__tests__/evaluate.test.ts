import { describe, expect, it } from "vitest";
import { compare, cooldownElapsed, DEFAULT_RULES, describeCondition, evaluateRule, METRICS, parseCondition, PLATFORM_DEFAULT_RULES } from "../evaluate";
import { categoryOf, entitiesOf, isAuditCategory } from "@/lib/audit-categories";
import { toCsv } from "@/lib/export/csv";

const cond = (op: "gt" | "gte" | "lt" | "lte" | "eq", threshold: number) => ({ condition: { metric: "m", op, threshold, window_min: 60 } });

describe("evaluateRule", () => {
  it("supports every operator at the boundary", () => {
    expect(evaluateRule(cond("gt", 5), { m: 5 }).breached).toBe(false);
    expect(evaluateRule(cond("gt", 5), { m: 6 }).breached).toBe(true);
    expect(evaluateRule(cond("gte", 5), { m: 5 }).breached).toBe(true);
    expect(evaluateRule(cond("lt", 5), { m: 5 }).breached).toBe(false);
    expect(evaluateRule(cond("lte", 5), { m: 5 }).breached).toBe(true);
    expect(compare("eq", 3, 3)).toBe(true);
  });
  it("treats a missing sample as not breached", () => {
    expect(evaluateRule(cond("gt", 0), {})).toEqual({ breached: false, value: null });
    expect(evaluateRule(cond("gt", 0), { m: Number.NaN })).toEqual({ breached: false, value: null });
  });
});

describe("cooldown", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  it("allows the first notification", () => expect(cooldownElapsed({ last_fired_at: null, cooldown_min: 60 }, now)).toBe(true));
  it("blocks within the cooldown and allows after", () => {
    expect(cooldownElapsed({ last_fired_at: "2026-01-01T11:30:00Z", cooldown_min: 60 }, now)).toBe(false);
    expect(cooldownElapsed({ last_fired_at: "2026-01-01T11:00:00Z", cooldown_min: 60 }, now)).toBe(true);
  });
});

describe("conditions and defaults", () => {
  it("parses and clamps stored conditions, rejecting junk", () => {
    expect(parseCondition('{"metric":"x","op":"gt","threshold":"3","window_min":999999}')).toEqual({ metric: "x", op: "gt", threshold: 3, window_min: 10080 });
    expect(parseCondition('{"metric":"x","op":"nope","threshold":1}')).toBeNull();
    expect(parseCondition("not json")).toBeNull();
  });
  it("ships exactly three enabled org defaults, all on known metrics", () => {
    expect(DEFAULT_RULES.filter((r) => r.enabled).map((r) => r.key).sort()).toEqual(["ai_budget", "outbox_failed", "webhook_dead"]);
    const keys = new Set(METRICS.map((m) => m.key));
    for (const r of [...DEFAULT_RULES, ...PLATFORM_DEFAULT_RULES]) expect(keys.has(r.condition.metric)).toBe(true);
    expect(new Set(DEFAULT_RULES.map((r) => r.key)).size).toBe(DEFAULT_RULES.length);
    expect(describeCondition(DEFAULT_RULES[0].condition)).toContain("60 min");
  });
});

describe("audit categories + CSV", () => {
  it("maps entities and keeps other as the complement", () => {
    expect(categoryOf("api_key")).toBe("access");
    expect(categoryOf("snapshot")).toBe("data");
    expect(categoryOf("mystery")).toBe("other");
    expect(entitiesOf("other")).toBeNull();
    expect(isAuditCategory("billing")).toBe(true);
    expect(isAuditCategory("x")).toBe(false);
  });
  it("neutralises spreadsheet formulas in exported audit cells", () => {
    const csv = toCsv([{ actor_email: "=HYPERLINK(\"http://evil\")", entity: "+cmd", diff: '{"a":["@x","y"]}' }], [{ key: "actor_email" }, { key: "entity" }, { key: "diff" }]);
    const row = csv.split("\r\n")[1];
    expect(row.startsWith("\"'=HYPERLINK")).toBe(true);
    expect(row).toContain(",'+cmd,");
  });
});
