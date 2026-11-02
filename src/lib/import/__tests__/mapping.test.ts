import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/dsql", () => ({ query: vi.fn(async () => []), queryOne: vi.fn(async () => null), withRetry: vi.fn(async (fn: () => unknown) => fn()) }));
vi.mock("@/lib/llm", () => ({ isLlmConfigured: () => false, complete: vi.fn() }));

import { heuristicMapping, normaliseHeader, sniffType, suggestMapping } from "@/lib/import/mapping";
import { coerceValue, dedupeKeyFor, toBoolean, toIsoDate, toMoneyMinor } from "@/lib/import/run";
import { IMPORT_TARGETS } from "@/lib/import/targets";

describe("normaliseHeader", () => {
  it("lower-cases, strips punctuation and collapses separators", () => {
    expect(normaliseHeader(" E-Mail_Address ")).toBe("e mail address");
    expect(normaliseHeader("﻿Full.Name")).toBe("full name");
  });
});

describe("sniffType", () => {
  it("recognises emails, phones, money, dates and booleans", () => {
    expect(sniffType(["a@b.co", "c@d.io"], "email")).toBe(1);
    expect(sniffType(["hello", "a@b.co"], "email")).toBe(0.5);
    expect(sniffType(["+1 (555) 123-4567", "020 7946 0958"], "phone")).toBe(1);
    expect(sniffType(["$1,200.00", "€35", "12.5"], "money")).toBe(1);
    expect(sniffType(["2024-01-05", "1/5/2024", "Jan 5 2024"], "date")).toBe(1);
    expect(sniffType(["yes", "no", "TRUE"], "boolean")).toBe(1);
    expect(sniffType(["", "  "], "email")).toBe(0);
  });
});

describe("heuristicMapping", () => {
  const contacts = IMPORT_TARGETS.crm_contacts;

  it("maps exact and synonym headers", () => {
    const headers = ["Full Name", "E-mail", "Phone Number", "Company", "Job Title", "Notes"];
    const rows = [["Ada Lovelace", "ada@x.io", "+1 555 0100", "Analytical", "Engineer", "VIP"]];
    const { mapping, unmappedHeaders } = heuristicMapping(headers, rows, contacts);
    expect(mapping.full_name).toBe("Full Name");
    expect(mapping.email).toBe("E-mail");
    expect(mapping.phone).toBe("Phone Number");
    expect(mapping.company).toBe("Company");
    expect(mapping.role).toBe("Job Title");
    expect(mapping.notes).toBe("Notes");
    expect(unmappedHeaders).toEqual([]);
  });

  it("uses value sniffing when header names are opaque", () => {
    const headers = ["col1", "col2", "col3"];
    const rows = [
      ["Ada", "ada@x.io", "$1,000"],
      ["Bob", "bob@x.io", "$250.50"],
    ];
    const { mapping } = heuristicMapping(headers, rows, contacts);
    expect(mapping.email).toBe("col2");
    expect(mapping.deal_value).toBe("col3");
  });

  it("never assigns one header to two fields and leaves unknown headers unmapped", () => {
    const headers = ["Email", "Shoe size"];
    const rows = [["a@b.co", "42"]];
    const { mapping, unmappedHeaders } = heuristicMapping(headers, rows, contacts);
    const used = Object.values(mapping).filter(Boolean);
    expect(new Set(used).size).toBe(used.length);
    expect(unmappedHeaders).toContain("Shoe size");
  });

  it("picks the enum field for a status column whose values match", () => {
    const headers = ["Name", "Status"];
    const rows = [
      ["Ada", "customer"],
      ["Bob", "prospect"],
    ];
    const { mapping } = heuristicMapping(headers, rows, contacts);
    expect(mapping.lifecycle).toBe("Status");
  });

  it("rejects a name match whose values contradict the type", () => {
    const headers = ["Email"];
    const rows = [["not an email"], ["still not"]];
    const { mapping } = heuristicMapping(headers, rows, contacts);
    expect(mapping.email).toBeNull();
  });

  it("maps expense exports from a bank statement", () => {
    const headers = ["Date", "Description", "Amount", "Merchant", "Category"];
    const rows = [["03/01/2024", "Coffee", "-4.50", "Blue Bottle", "Meals"]];
    const { mapping } = heuristicMapping(headers, rows, IMPORT_TARGETS.expenses);
    expect(mapping.spent_at).toBe("Date");
    expect(mapping.amount_minor).toBe("Amount");
    expect(mapping.vendor).toBe("Merchant");
    expect(mapping.category).toBe("Category");
    expect(mapping.description).toBe("Description");
  });
});

describe("suggestMapping", () => {
  it("falls back to the heuristic when no LLM is configured", async () => {
    const s = await suggestMapping(["Name", "Email"], [["Ada", "ada@x.io"]], IMPORT_TARGETS.crm_contacts);
    expect(s.source).toBe("heuristic");
    expect(s.mapping.email).toBe("Email");
  });
});

describe("coercion", () => {
  it("parses money into minor units", () => {
    expect(toMoneyMinor("$1,234.56")).toBe(123456);
    expect(toMoneyMinor("1.234,56")).toBe(123456);
    expect(toMoneyMinor("1,234")).toBe(123400);
    expect(toMoneyMinor("12,50")).toBe(1250);
    expect(toMoneyMinor("(12.00)")).toBe(-1200);
    expect(toMoneyMinor("-4.5")).toBe(-450);
    expect(toMoneyMinor("€ 99")).toBe(9900);
    expect(toMoneyMinor("1.234.567")).toBe(123456700);
    expect(toMoneyMinor("0.005")).toBe(1);
    expect(toMoneyMinor("abc")).toBeNull();
  });

  it("parses dates (ISO, US, day-first when unambiguous)", () => {
    expect(toIsoDate("2024-01-05", false)).toBe("2024-01-05");
    expect(toIsoDate("1/5/2024", false)).toBe("2024-01-05");
    expect(toIsoDate("25/12/2024", false)).toBe("2024-12-25");
    expect(toIsoDate("2024-01-05T10:30:00Z", true)).toBe("2024-01-05T10:30:00.000Z");
    expect(toIsoDate("2024-01-05 10:30", true)).toBe("2024-01-05T10:30:00.000Z");
    expect(toIsoDate("nonsense", false)).toBeNull();
  });

  it("a date-only import of a zone-less datetime keeps the written day regardless of server zone", () => {
    // Previously parsed with `new Date(v)` (server-local), so "23:30" could land on the next/previous day.
    expect(toIsoDate("2024-01-05 23:30", false)).toBe("2024-01-05");
    expect(toIsoDate("2024-01-05T00:15:00", false)).toBe("2024-01-05");
    expect(toIsoDate("2024-01-05T23:30:00Z", false)).toBe("2024-01-05");
  });

  it("parses European and US money formats to minor units", () => {
    expect(toMoneyMinor("1.234,56")).toBe(123456);
    expect(toMoneyMinor("1,234.56")).toBe(123456);
    expect(toMoneyMinor("€1.234,56")).toBe(123456);
    expect(toMoneyMinor("1,234")).toBe(123400);
    expect(toMoneyMinor("12,50")).toBe(1250);
    expect(toMoneyMinor("(12.00)")).toBe(-1200);
    expect(toMoneyMinor("-$5")).toBe(-500);
    expect(toMoneyMinor("1.005")).toBe(101);
  });

  it("parses booleans", () => {
    expect(toBoolean("Yes")).toBe(true);
    expect(toBoolean("0")).toBe(false);
    expect(toBoolean("maybe")).toBeNull();
  });

  it("coerceValue reports type errors and matches enums loosely", () => {
    const email = IMPORT_TARGETS.crm_contacts.fields.find((f) => f.key === "email")!;
    expect(coerceValue("ADA@X.IO", email)).toEqual({ value: "ada@x.io" });
    expect(coerceValue("nope", email).error).toMatch(/not an email/);
    const lifecycle = IMPORT_TARGETS.crm_contacts.fields.find((f) => f.key === "lifecycle")!;
    expect(coerceValue("Customer (active)", lifecycle)).toEqual({ value: "customer" });
    const tags = IMPORT_TARGETS.crm_contacts.fields.find((f) => f.key === "tags")!;
    expect(coerceValue("a, b; a |c", tags)).toEqual({ value: ["a", "b", "c"] });
  });

  it("builds dedupe keys case-insensitively and skips all-blank keys", () => {
    const t = IMPORT_TARGETS.crm_contacts;
    expect(dedupeKeyFor({ email: "Ada@X.io" }, t)).toBe("ada@x.io");
    expect(dedupeKeyFor({ email: null }, t)).toBeNull();
    expect(dedupeKeyFor({ vendor: "Shop", amount_minor: 450, spent_at: "2024-03-01" }, IMPORT_TARGETS.expenses)).toBe("shop|450|2024-03-01");
  });
});
