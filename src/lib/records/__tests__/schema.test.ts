import { describe, expect, it } from "vitest";
import {
  FieldDefSchema,
  RecordTypeInputSchema,
  RecordValidationError,
  resolveStage,
  slugifyRecordType,
  toMinor,
  validateRecordData,
  validateViews,
} from "../schema";
import { LEGACY_HUB_TO_PACK, PACKS, getPack } from "../packs";
import type { FieldDef } from "../types";

const fields: FieldDef[] = [
  { key: "name", label: "Name", type: "text", required: true },
  { key: "email", label: "Email", type: "email" },
  { key: "age", label: "Age", type: "number" },
  { key: "price", label: "Price", type: "money" },
  { key: "when", label: "When", type: "date" },
  { key: "kind", label: "Kind", type: "select", options: ["a", "b"] },
  { key: "tags", label: "Tags", type: "multiselect", options: ["x", "y"] },
  { key: "ok", label: "OK", type: "boolean" },
  { key: "site", label: "Site", type: "url" },
];

describe("validateRecordData", () => {
  it("coerces numbers, money (to minor units), dates and booleans", () => {
    const out = validateRecordData(fields, {
      name: "  Ada ",
      email: "ADA@Example.com",
      age: "42",
      price: "1,250.50",
      when: "2026-01-02",
      kind: "a",
      tags: "x, y",
      ok: "yes",
      site: "example.com",
    });
    expect(out.name).toBe("Ada");
    expect(out.email).toBe("ada@example.com");
    expect(out.age).toBe(42);
    expect(out.price).toBe(125050);
    expect(out.when).toBe(new Date("2026-01-02").toISOString());
    expect(out.tags).toEqual(["x", "y"]);
    expect(out.ok).toBe(true);
    expect(out.site).toBe("example.com");
  });

  it("accepts money as a number of major units and as {minor}", () => {
    expect(validateRecordData(fields, { name: "a", price: 12.34 }).price).toBe(1234);
    expect(validateRecordData(fields, { name: "a", price: { minor: 999 } }).price).toBe(999);
  });

  it("rejects missing required fields unless partial", () => {
    expect(() => validateRecordData(fields, {})).toThrow(RecordValidationError);
    expect(validateRecordData(fields, {}, true)).toEqual({});
  });

  it("collects every issue", () => {
    try {
      validateRecordData(fields, { name: "a", email: "nope", age: "abc", kind: "zzz", tags: ["q"] });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RecordValidationError);
      const issues = (e as RecordValidationError).issues;
      expect(issues.some((i) => /email/i.test(i))).toBe(true);
      expect(issues.some((i) => /Age/.test(i))).toBe(true);
      expect(issues.some((i) => /Kind/.test(i))).toBe(true);
      expect(issues.some((i) => /"q"/.test(i))).toBe(true);
    }
  });

  it("drops unknown keys but keeps _legacy_id", () => {
    const out = validateRecordData(fields, { name: "a", evil: "x", _legacy_id: "t:1" });
    expect(out).toEqual({ name: "a", _legacy_id: "t:1" });
  });

  it("writes null for explicitly blanked optional fields", () => {
    expect(validateRecordData(fields, { name: "a", email: "" })).toEqual({ name: "a", email: null });
  });

  it("rejects non-object input", () => {
    expect(() => validateRecordData(fields, "nope")).toThrow(RecordValidationError);
  });
});

describe("toMinor", () => {
  it("handles strings, numbers and garbage", () => {
    expect(toMinor("$1,000.10")).toBe(100010);
    expect(toMinor(5)).toBe(500);
    expect(toMinor("abc")).toBeNull();
    expect(toMinor(null)).toBeNull();
  });
});

describe("resolveStage", () => {
  const stages = [{ key: "new", label: "New" }, { key: "done", label: "Done" }];
  it("defaults to the first stage and rejects unknown ones", () => {
    expect(resolveStage(stages, undefined)).toBe("new");
    expect(resolveStage(stages, "done")).toBe("done");
    expect(() => resolveStage(stages, "nope")).toThrow(RecordValidationError);
  });
});

describe("type schemas", () => {
  it("requires options on select fields", () => {
    expect(FieldDefSchema.safeParse({ key: "k", label: "K", type: "select" }).success).toBe(false);
    expect(FieldDefSchema.safeParse({ key: "k", label: "K", type: "select", options: ["a"] }).success).toBe(true);
  });
  it("rejects duplicate field keys, reserved slugs and bad keys", () => {
    const base = { name: "T", stages: [{ key: "a", label: "A" }] };
    expect(RecordTypeInputSchema.safeParse({ ...base, fields: [{ key: "x", label: "X", type: "text" }, { key: "x", label: "Y", type: "text" }] }).success).toBe(false);
    expect(RecordTypeInputSchema.safeParse({ ...base, slug: "types", fields: [] }).success).toBe(false);
    expect(RecordTypeInputSchema.safeParse({ ...base, fields: [{ key: "Bad-Key", label: "X", type: "text" }] }).success).toBe(false);
    expect(RecordTypeInputSchema.safeParse({ ...base, fields: [] }).success).toBe(true);
  });
  it("validates view references", () => {
    expect(validateViews({ amountField: "price", dueField: "when" }, fields)).toEqual([]);
    expect(validateViews({ amountField: "age" }, fields)).toHaveLength(1);
    expect(validateViews({ tableColumns: ["nope"] }, fields)).toHaveLength(1);
  });
  it("slugifies names", () => {
    expect(slugifyRecordType("Field Service Jobs!")).toBe("field-service-jobs");
  });
});

describe("pack integrity", () => {
  it("has unique pack slugs and unique type slugs across packs", () => {
    const packSlugs = PACKS.map((p) => p.slug);
    expect(new Set(packSlugs).size).toBe(packSlugs.length);
    const typeSlugs = PACKS.flatMap((p) => p.recordTypes.map((t) => t.slug));
    expect(new Set(typeSlugs).size).toBe(typeSlugs.length);
  });

  it("includes every vertical and generic pack", () => {
    for (const slug of ["healthcare", "education", "legal", "finance", "realestate", "ecommerce", "nonprofit", "startup", "agency", "projects", "hiring", "fleet", "field-service"]) {
      expect(getPack(slug), slug).toBeDefined();
    }
    for (const pack of Object.values(LEGACY_HUB_TO_PACK)) expect(getPack(pack)).toBeDefined();
  });

  it("every type passes the input schema and its views reference real fields", () => {
    for (const p of PACKS) {
      expect(p.recordTypes.length, p.slug).toBeGreaterThan(0);
      for (const t of p.recordTypes) {
        const parsed = RecordTypeInputSchema.safeParse({
          slug: t.slug,
          name: t.name,
          icon: t.icon,
          description: t.description,
          fields: t.fields,
          stages: t.stages,
          views: t.views ?? {},
          copilot_prompt: t.copilot_prompt,
        });
        expect(parsed.success, `${p.slug}/${t.slug}: ${parsed.success ? "" : JSON.stringify(parsed.error.flatten())}`).toBe(true);
        expect(validateViews(t.views ?? {}, t.fields), `${p.slug}/${t.slug}`).toEqual([]);
        expect(t.stages.length, `${p.slug}/${t.slug} stages`).toBeGreaterThan(0);
        expect(t.copilot_prompt.length).toBeGreaterThan(10);
      }
    }
  });

  it("partial validation lets a required field be omitted but not cleared to blank", () => {
    const fields = [
      { key: "name", label: "Name", type: "text" as const, required: true },
      { key: "note", label: "Note", type: "text" as const },
    ];
    // Omitted: fine on an update.
    expect(validateRecordData(fields, { note: "x" }, true)).toEqual({ note: "x" });
    // Optional field explicitly cleared: allowed, stored as null.
    expect(validateRecordData(fields, { note: "" }, true)).toEqual({ note: null });
    // Required field explicitly cleared: rejected, never written as null.
    for (const blank of ["", null, undefined]) {
      expect(() => validateRecordData(fields, { name: blank }, true)).toThrow(RecordValidationError);
    }
    // Full validation still requires it.
    expect(() => validateRecordData(fields, { note: "x" })).toThrow(/Name is required/);
  });

  it("legacy stage mappings only point at stages that exist", () => {
    const stagesOf = (pack: string, type: string) => getPack(pack)!.recordTypes.find((t) => t.slug === type)!.stages.map((s) => s.key);
    expect(stagesOf("legal", "matters")).toEqual(expect.arrayContaining(["active", "on_hold", "settled", "won", "closed"]));
    expect(stagesOf("realestate", "properties")).toEqual(expect.arrayContaining(["active", "pending", "sold", "rented"]));
    expect(stagesOf("startup", "investors")).toEqual(expect.arrayContaining(["identified", "contacted", "meeting", "term_sheet", "closed", "passed"]));
    expect(stagesOf("ecommerce", "products")).toEqual(expect.arrayContaining(["live", "low_stock", "out_of_stock"]));
    expect(stagesOf("education", "students")).toEqual(expect.arrayContaining(["enrolled", "in_progress", "completed"]));
    expect(stagesOf("nonprofit", "donors")).toEqual(expect.arrayContaining(["active", "lapsed"]));
    expect(stagesOf("finance", "portfolios")).toContain("holding");
    expect(stagesOf("healthcare", "patients")).toContain("intake");
  });
});
