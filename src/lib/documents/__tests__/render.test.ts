import { describe, expect, it } from "vitest";
import { documentHash, escapeMergeValue, extractMergeKeys, markdownToText, missingRequired, parseInline, parseMarkdown, renderDocumentPdf, renderMerge, type SignerStamp } from "@/lib/documents/render";
import { STARTER_TEMPLATES } from "@/lib/documents/starters";

/** Parse our own output: locate the xref table and check every offset points at "N 0 obj". */
function parseXref(bytes: Uint8Array): { size: number; offsets: number[]; text: string } {
  const text = Buffer.from(bytes).toString("latin1");
  expect(text.startsWith("%PDF-1.4\n")).toBe(true);
  expect(text.endsWith("%%EOF\n")).toBe(true);
  const sx = text.lastIndexOf("startxref\n");
  const xrefOffset = Number(text.slice(sx + "startxref\n".length).split("\n")[0]);
  expect(text.slice(xrefOffset, xrefOffset + 5)).toBe("xref\n");
  const lines = text.slice(xrefOffset).split("\n");
  const [, count] = lines[1].split(" ").map(Number);
  const offsets: number[] = [];
  for (let i = 1; i < count; i++) {
    const entry = lines[2 + i];
    expect(entry).toMatch(/^\d{10} \d{5} n $/);
    offsets.push(Number(entry.slice(0, 10)));
  }
  return { size: count, offsets, text };
}

describe("merge fields", () => {
  it("extracts keys in order, once", () => {
    expect(extractMergeKeys("Hi {{ contact.full_name }}, from {{org.name}} and {{contact.full_name}} / {{fee}}")).toEqual(["contact.full_name", "org.name", "fee"]);
  });

  it("substitutes values and reports blanks as visible gaps", () => {
    const out = renderMerge("Dear {{contact.full_name}}, fee {{fee}}.", { "contact.full_name": "Ada", fee: "" });
    expect(out.body).toBe("Dear Ada, fee ______.");
    expect(out.missing).toEqual(["fee"]);
  });

  it("escapes markdown in merged values so content never becomes markup", () => {
    expect(escapeMergeValue("# Boss")).toBe("\\# Boss");
    expect(escapeMergeValue("**free**")).toBe("\\*\\*free\\*\\*");
    expect(escapeMergeValue("- not a bullet\n1. not a list\n| a | b |")).toBe("\\- not a bullet\n\\1. not a list\n\\| a \\| b \\|");
    const merged = renderMerge("{{v}}", { v: "# Boss" }).body;
    const blocks = parseMarkdown(merged);
    expect(blocks[0].type).toBe("paragraph");
    expect(markdownToText(merged)).toBe("# Boss");
  });

  it("is single-pass: a merged value containing {{...}} is not expanded", () => {
    const out = renderMerge("{{a}}", { a: "{{b}}", b: "SECRET" });
    expect(out.body).toBe("{{b}}");
    expect(out.missing).toEqual([]);
  });

  it("flags blank required fields", () => {
    expect(missingRequired([{ key: "a", label: "A", source: "custom", required: true }, { key: "b", label: "B", source: "custom" }], { a: " ", b: "" })).toEqual(["a"]);
  });
});

describe("markdown subset", () => {
  it("parses headings, paragraphs, lists, tables, rules and bold runs", () => {
    const blocks = parseMarkdown("# Title\n\nSome **bold** text\nsame paragraph.\n\n- one\n- two\n\n1. first\n2. second\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n---\n");
    expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "list", "list", "table", "rule"]);
    expect(parseInline("a **b** c")).toEqual([{ text: "a ", bold: false }, { text: "b", bold: true }, { text: " c", bold: false }]);
    const table = blocks[4];
    if (table.type === "table") expect(table.rows).toEqual([["A", "B"], ["1", "2"]]);
    const list = blocks[2];
    if (list.type === "list") expect(list.ordered).toBe(false);
  });

  it("every starter template parses to at least one heading and only uses declared merge keys", () => {
    for (const s of STARTER_TEMPLATES) {
      const blocks = parseMarkdown(s.body_md);
      expect(blocks.some((b) => b.type === "heading"), s.slug).toBe(true);
      const declared = new Set(s.fields.map((f) => f.key));
      for (const k of extractMergeKeys(s.body_md)) expect(declared.has(k), `${s.slug}: ${k}`).toBe(true);
    }
  });
});

const DOC = {
  title: "Service Agreement",
  kind: "contract" as const,
  body_md: STARTER_TEMPLATES[0].body_md.replace(/\{\{[^}]+\}\}/g, "X"),
  created_at: "2026-11-01T10:00:00.000Z",
  sent_at: "2026-11-02T10:00:00.000Z",
  expires_at: "2026-12-02T10:00:00.000Z",
  status: "sent",
  reference: "DOC-ABCD1234",
};
const BRAND = { brand_name: "Acme Studio", support_email: "help@acme.test", primary_color: "#336699" };

describe("document PDF", () => {
  it("renders a parseable PDF whose xref offsets all point at objects", () => {
    const bytes = renderDocumentPdf(DOC, null, BRAND);
    const { offsets, text } = parseXref(bytes);
    offsets.forEach((o, i) => expect(text.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    expect(text).toContain("/Title (Service Agreement)");
    expect(text).toContain("Acme Studio");
  });

  it("is deterministic so the unsigned hash can be re-derived", () => {
    const a = renderDocumentPdf(DOC, null, BRAND);
    const b = renderDocumentPdf(DOC, null, BRAND);
    expect(documentHash(a)).toBe(documentHash(b));
    expect(documentHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("appends a signature certificate page per signer with the unsigned fingerprint", () => {
    const unsigned = renderDocumentPdf(DOC, null, BRAND);
    const hash = documentHash(unsigned);
    const stamps: SignerStamp[] = [
      { name: "Ada Client", email: "ada@example.test", role: "client", signature_text: "Ada Client", signed_at: "2026-11-03T09:00:00.000Z", ip: "203.0.113.9", user_agent: "UA", consent_text: null },
      { name: "Bob Provider", email: "bob@acme.test", role: "provider", signature_text: "B. Provider", signed_at: "2026-11-03T10:00:00.000Z", ip: "198.51.100.2", user_agent: "UA2", consent_text: null },
    ];
    const signed = renderDocumentPdf({ ...DOC, status: "signed", completed_at: "2026-11-03T10:00:00.000Z" }, stamps, BRAND, { documentHash: hash, timezone: "Europe/London" });
    const { text, size } = parseXref(signed);
    const unsignedInfo = parseXref(unsigned);
    expect(size).toBeGreaterThan(unsignedInfo.size); // extra page + content
    expect(text).toContain("ELECTRONICALLY SIGNED");
    expect(text).toContain("Ada Client");
    expect(text).toContain("B. Provider");
    expect(text).toContain(hash);
    expect(text).toContain("203.0.113.9");
    const redacted = Buffer.from(renderDocumentPdf({ ...DOC, status: "signed" }, stamps, BRAND, { documentHash: hash, redactEvidence: true })).toString("latin1");
    expect(redacted).not.toContain("203.0.113.9");
    expect(redacted).toContain("IP and device recorded");
    expect(documentHash(signed)).not.toBe(hash);
  });
});
