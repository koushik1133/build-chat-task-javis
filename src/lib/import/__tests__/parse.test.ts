import { describe, expect, it } from "vitest";
import { detectDelimiter, parseCsv, parseCsvRecords, rowsToObjects, uniqueHeaders } from "@/lib/import/parse";

describe("parseCsvRecords (RFC 4180)", () => {
  it("splits simple comma rows with LF", () => {
    expect(parseCsvRecords("a,b,c\n1,2,3\n").records).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles CRLF and a trailing record without newline", () => {
    expect(parseCsvRecords("a,b\r\n1,2\r\n3,4").records).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("handles bare CR line endings", () => {
    expect(parseCsvRecords("a,b\r1,2\r").records).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("strips a UTF-8 BOM", () => {
    const { records } = parseCsvRecords("﻿name,email\nAda,ada@x.io");
    expect(records[0]).toEqual(["name", "email"]);
  });

  it("supports quoted fields with commas, escaped quotes and embedded newlines", () => {
    const text = 'name,note\n"Smith, John","He said ""hi""\nthen left"\n';
    const { records } = parseCsvRecords(text);
    expect(records).toEqual([
      ["name", "note"],
      ["Smith, John", 'He said "hi"\nthen left'],
    ]);
  });

  it("keeps empty fields and leading/trailing empties", () => {
    expect(parseCsvRecords("a,,c\n,2,\n").records).toEqual([
      ["a", "", "c"],
      ["", "2", ""],
    ]);
  });

  it("treats a quote inside an unquoted field literally", () => {
    expect(parseCsvRecords('5" screen,x\n').records).toEqual([['5" screen', "x"]]);
  });

  it("auto-detects semicolon and tab delimiters", () => {
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(detectDelimiter("a\tb\tc")).toBe("\t");
    expect(detectDelimiter('"x, y";b')).toBe(";");
    expect(parseCsvRecords("a;b\n1;2").records[1]).toEqual(["1", "2"]);
  });
});

describe("parseCsv (headers + rows)", () => {
  it("uses the first non-blank line as headers and drops blank rows", () => {
    const parsed = parseCsv("\n\nName, Email \nAda,ada@x.io\n\n,\nBob,bob@x.io\n");
    expect(parsed.headers).toEqual(["Name", "Email"]);
    expect(parsed.rows).toEqual([
      ["Ada", "ada@x.io"],
      ["Bob", "bob@x.io"],
    ]);
    expect(parsed.blankRows).toBe(2);
  });

  it("pads short rows to the header width and names blank headers", () => {
    const parsed = parseCsv("a,,c\n1\n");
    expect(parsed.headers).toEqual(["a", "column_2", "c"]);
    expect(parsed.rows).toEqual([["1", "", ""]]);
  });

  it("returns empty for an empty file", () => {
    expect(parseCsv("")).toEqual({ headers: [], rows: [], delimiter: ",", blankRows: 0 });
  });

  it("respects maxRows", () => {
    const text = "h\n" + Array.from({ length: 20 }, (_, i) => String(i)).join("\n");
    expect(parseCsv(text, { maxRows: 5 }).rows).toHaveLength(5);
  });

  it("rowsToObjects keys by header with duplicate suffixes", () => {
    expect(uniqueHeaders(["a", "a", "b", "a"])).toEqual(["a", "a_2", "b", "a_3"]);
    const parsed = parseCsv("a,a\n1,2");
    expect(rowsToObjects(parsed)).toEqual([{ a: "1", a_2: "2" }]);
  });
});
