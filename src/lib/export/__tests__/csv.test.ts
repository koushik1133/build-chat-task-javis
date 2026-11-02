import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "@/lib/export/csv";
import { EXPORT_ENTITIES, exportFileName, expandJson, parseDateParam, renderExport } from "@/lib/export";

describe("csvCell", () => {
  it("quotes commas, quotes and newlines", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell("plain")).toBe("plain");
  });

  it("neutralises spreadsheet formula injection", () => {
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-5")).toBe("'-5");
    expect(csvCell("@cmd")).toBe("'@cmd");
  });

  it("serialises null, dates, numbers, booleans and objects", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(12)).toBe("12");
    expect(csvCell(true)).toBe("true");
    expect(csvCell(new Date("2024-01-01T00:00:00Z"))).toBe("2024-01-01T00:00:00.000Z");
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });
});

describe("toCsv", () => {
  it("writes header + rows with CRLF and an optional BOM", () => {
    const out = toCsv([{ id: "1", name: "Ada" }, { id: "2", name: "Bob, Jr" }], [{ key: "id" }, { key: "name", label: "Name" }]);
    expect(out).toBe('id,Name\r\n1,Ada\r\n2,"Bob, Jr"\r\n');
    expect(toCsv([], [{ key: "id" }], { bom: true })).toBe("﻿id\r\n");
  });
});

describe("export helpers", () => {
  it("parseDateParam accepts dates and ISO strings", () => {
    expect(parseDateParam("2024-01-05")?.toISOString()).toBe("2024-01-05T00:00:00.000Z");
    expect(parseDateParam("2024-01-05", true)?.toISOString()).toBe("2024-01-05T23:59:59.999Z");
    expect(parseDateParam("garbage")).toBeNull();
    expect(parseDateParam(null)).toBeNull();
  });

  it("expands JSON text columns for JSON output only", () => {
    const rows = [{ id: "1", tags: '["a","b"]' }];
    expect(expandJson(rows, EXPORT_ENTITIES.contacts)[0].tags).toEqual(["a", "b"]);
    const csv = renderExport(rows, EXPORT_ENTITIES.contacts, "csv");
    expect(csv.contentType).toMatch(/text\/csv/);
    expect(csv.body).toContain('"[""a"",""b""]"');
    const json = JSON.parse(renderExport(rows, EXPORT_ENTITIES.contacts, "json").body);
    expect(json.rows[0].tags).toEqual(["a", "b"]);
    expect(json.count).toBe(1);
  });

  it("names files by entity, type and date", () => {
    expect(exportFileName(EXPORT_ENTITIES.contacts, "csv")).toMatch(/^contacts-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(exportFileName(EXPORT_ENTITIES.records, "json", { type: "deal/s" })).toMatch(/^records-deals-\d{4}-\d{2}-\d{2}\.json$/);
  });

  it("whitelists columns and never includes user_id", () => {
    for (const e of Object.values(EXPORT_ENTITIES)) {
      expect(e.columns).not.toContain("user_id");
      expect(e.columns).not.toContain("*");
      expect(e.columns).toContain(e.dateColumn);
    }
  });
});
