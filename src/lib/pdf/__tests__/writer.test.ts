import { describe, expect, it } from "vitest";
import { PdfDocument, encodePdfString, measureText, wrapLines } from "@/lib/pdf/writer";
import { CONSENT_TEXT, documentHash, fmtInstant, fmtMinor, renderInvoicePdf, renderQuotePdf, type QuoteDocInput, type SignatureStamp } from "@/lib/pdf/quote-document";

/** Parse our own output: locate the xref table and check every offset points at "N 0 obj". */
function parseXref(bytes: Uint8Array): { size: number; offsets: number[]; root: string } {
  const buf = Buffer.from(bytes);
  const text = buf.toString("latin1");
  expect(text.startsWith("%PDF-1.4\n")).toBe(true);
  expect(text.endsWith("%%EOF\n")).toBe(true);
  const sx = text.lastIndexOf("startxref\n");
  expect(sx).toBeGreaterThan(0);
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
  const trailer = text.slice(text.lastIndexOf("trailer"));
  const root = /\/Root (\d+ 0 R)/.exec(trailer)?.[1] ?? "";
  return { size: count, offsets, root };
}

const quote: QuoteDocInput = {
  number: "Q-000042",
  status: "sent",
  currency: "USD",
  items: [
    { description: "Website redesign — discovery, wireframes and (two) rounds of revisions \\ incl. hand-off", qty: 1, unit_minor: 250000, tax_rate_bp: 825 },
    { description: "Hosting (12 months)", qty: 12, unit_minor: 2500, tax_rate_bp: 0 },
  ],
  subtotal_minor: 280000,
  tax_minor: 20625,
  total_minor: 300625,
  valid_until: "2026-12-01T00:00:00.000Z",
  terms_version: "v1",
  terms_text: "By accepting this quote you agree to the scope, pricing and validity period shown above.\n\nWork begins once accepted.",
  notes: "Thanks for the opportunity — ¡gracias! “Quotes” & ‘apostrophes’ survive WinAnsi.",
  contact_name: "Ada Lovelace",
  contact_email: "ada@example.com",
  created_at: "2026-11-01T10:00:00.000Z",
  sent_at: "2026-11-01T12:00:00.000Z",
  current_version: 2,
};

describe("PdfDocument", () => {
  it("produces a parseable structure with correct xref offsets", () => {
    const doc = new PdfDocument({ title: "Test (1) \\ two" });
    const p1 = doc.addPage();
    p1.text(50, 50, "Hello (world) \\ back", { size: 12, font: "Helvetica-Bold" });
    p1.line(50, 60, 500, 60);
    p1.rect(50, 70, 100, 20, { fill: [0.9, 0.9, 0.9], stroke: [0, 0, 0] });
    const p2 = doc.addPage();
    p2.textBlock(50, 50, "A fairly long paragraph that will need to be wrapped across multiple lines to fit the width.", { maxWidth: 120, size: 10 });
    const bytes = doc.render();
    const { size, offsets, root } = parseXref(bytes);
    // 1 catalog + 2 pages tree + 3 fonts + 6 info + 2 pages × (page + content) = 10 objects, size = 11
    expect(size).toBe(11);
    expect(root).toBe("1 0 R");
    const text = Buffer.from(bytes).toString("latin1");
    offsets.forEach((off, i) => {
      expect(text.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
    expect(text).toContain("/Count 2");
    // Content streams declare their exact byte length.
    const m = /<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/.exec(text);
    expect(m).not.toBeNull();
    expect(Buffer.byteLength(m![2], "latin1")).toBe(Number(m![1]));
    // Escaping of delimiters inside literal strings.
    expect(text).toContain("(Hello \\(world\\) \\\\ back) Tj");
  });

  it("escapes and maps strings to WinAnsi", () => {
    expect(encodePdfString("a(b)c\\d")).toBe("a\\(b\\)c\\\\d");
    expect(encodePdfString("“x” – €")).toBe("\x93x\x94 \x96 \x80");
    expect(encodePdfString("₹ 10")).toBe("? 10");
    expect(encodePdfString("line\nbreak")).toBe("line break");
  });

  it("measures and wraps with Helvetica metrics", () => {
    expect(measureText("iii", 10)).toBeLessThan(measureText("WWW", 10));
    expect(measureText("WWW", 10, "Helvetica-Bold")).toBeGreaterThanOrEqual(measureText("WWW", 10));
    const lines = wrapLines("one two three four five six seven", 60, 10);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(measureText(l, 10)).toBeLessThanOrEqual(60);
    // Over-long token is broken rather than overflowing.
    const broken = wrapLines("x".repeat(200), 50, 10);
    expect(broken.length).toBeGreaterThan(1);
    for (const l of broken) expect(measureText(l, 10)).toBeLessThanOrEqual(50);
    expect(wrapLines("a\n\nb", 100, 10)).toEqual(["a", "", "b"]);
  });
});

describe("renderQuotePdf", () => {
  const branding = { brand_name: "Acme Studio", support_email: "hello@acme.test", primary_color: "#1d4ed8" };

  it("is deterministic: identical input yields identical bytes and hash", () => {
    const a = renderQuotePdf(quote, null, branding);
    const b = renderQuotePdf(quote, null, branding);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(documentHash(a)).toBe(documentHash(b));
    expect(documentHash(a)).toMatch(/^[0-9a-f]{64}$/);
    // Any change to the content changes the fingerprint.
    const c = renderQuotePdf({ ...quote, total_minor: quote.total_minor + 1 }, null, branding);
    expect(documentHash(c)).not.toBe(documentHash(a));
    parseXref(a);
  });

  it("stamps the signature block onto the accepted version", () => {
    const unsigned = renderQuotePdf(quote, null, branding);
    const stamp: SignatureStamp = {
      name: "Ada Lovelace",
      email: "ada@example.com",
      signature_text: "Ada Lovelace",
      signed_at: "2026-11-02T15:04:05.000Z",
      ip: "203.0.113.9",
      user_agent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      consent_terms_version: "v1",
      consent_terms_text: quote.terms_text,
      document_hash: documentHash(unsigned),
    };
    const signed = renderQuotePdf({ ...quote, status: "accepted", accepted_at: stamp.signed_at }, stamp, branding, { timezone: "America/Chicago" });
    const text = Buffer.from(signed).toString("latin1");
    parseXref(signed);
    expect(text).toContain("ELECTRONICALLY ACCEPTED AND SIGNED");
    expect(text).toContain("203.0.113.9");
    expect(text).toContain("2026-11-02 15:04:05 UTC");
    expect(text).toContain("2026-11-02 09:04:05");
    expect(text).toContain(stamp.document_hash.slice(0, 40));
    expect(text).toContain("/F3"); // oblique font used for the typed signature
    expect(text).toContain(encodePdfString(CONSENT_TEXT.slice(0, 30)));
    expect(documentHash(signed)).not.toBe(documentHash(unsigned));
    // Re-rendering the signed document reproduces the stored signed hash.
    const again = renderQuotePdf({ ...quote, status: "accepted", accepted_at: stamp.signed_at }, stamp, branding, { timezone: "America/Chicago" });
    expect(documentHash(again)).toBe(documentHash(signed));
  });

  it("paginates long item lists and numbers every page", () => {
    const items = Array.from({ length: 80 }, (_, i) => ({ description: `Line item number ${i + 1} with a reasonably long description so it wraps`, qty: i + 1, unit_minor: 1234, tax_rate_bp: 500 }));
    const bytes = renderQuotePdf({ ...quote, items }, null, branding);
    const text = Buffer.from(bytes).toString("latin1");
    const count = Number(/\/Count (\d+)/.exec(text)?.[1]);
    expect(count).toBeGreaterThan(1);
    expect(text).toContain(`(Page ${count} of ${count}) Tj`);
    parseXref(bytes);
  });

  it("renders invoices", () => {
    const bytes = renderInvoicePdf(
      { number: "INV-000007", status: "partially_paid", currency: "EUR", items: quote.items, subtotal_minor: 280000, tax_minor: 20625, total_minor: 300625, paid_minor: 100000, due_at: "2026-12-15T00:00:00Z", notes: null, contact_name: "Ada", created_at: quote.created_at, quote_number: "Q-000042" },
      branding
    );
    const text = Buffer.from(bytes).toString("latin1");
    expect(text).toContain("(INVOICE) Tj");
    expect(text).toContain("Balance due");
    expect(text).toContain(encodePdfString(fmtMinor(200625, "EUR")));
    parseXref(bytes);
  });
});

describe("formatting helpers", () => {
  it("formats minor units without locale-dependent glyphs", () => {
    expect(fmtMinor(300625, "USD")).toBe("3,006.25 USD");
    expect(fmtMinor(-5, "GBP")).toBe("-0.05 GBP");
    expect(fmtMinor(0, "INR")).toBe("0.00 INR");
  });
  it("formats instants in UTC and a named zone, falling back to UTC for junk", () => {
    expect(fmtInstant("2026-11-02T15:04:05Z", "UTC")).toBe("2026-11-02 15:04:05 UTC");
    expect(fmtInstant("2026-11-02T15:04:05Z", "Not/AZone")).toBe("2026-11-02 15:04:05 UTC");
    expect(fmtInstant("2026-11-02T15:04:05Z", "Asia/Kolkata")).toMatch(/^2026-11-02 20:34:05 /);
  });
});
