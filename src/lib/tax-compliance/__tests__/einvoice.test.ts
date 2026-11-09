import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { describe, expect, it } from "vitest";
import { buildPeppolUbl, dec, xmlEscape } from "../einvoice/peppol-ubl";
import { buildIrpJson, financialYear, simulateIrpSubmission } from "../einvoice/india-irp";
import type { EDoc } from "../einvoice/types";

/** Golden fixtures live in __tests__/fixtures; run with UPDATE_GOLDEN=1 to (re)write them after reviewing a change. */
function golden(name: string, actual: string): string | null {
  const file = join(__dirname, "fixtures", name);
  if (process.env.UPDATE_GOLDEN === "1" || !existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, actual);
    return null;
  }
  return readFileSync(file, "utf8");
}
const norm = (s: string) => s.replace(/>\s+</g, "><").replace(/\s+/g, " ").trim();

const euDoc = (over: Partial<EDoc> = {}): EDoc => ({
  kind: "invoice", number: "INV-000042", issue_date: "2026-03-05", due_date: "2026-04-04", currency: "EUR",
  seller: { name: "Acme & Söhne GmbH", tax_id: "DE123456789", country: "DE", address_line1: "Hauptstr. 1", city: "Berlin", postal_code: "10115", email: "ar@acme.example" },
  buyer: { name: "Société <Exemple>", tax_id: "FR12345678901", country: "FR", address_line1: "1 rue de Paris", city: "Paris", postal_code: "75001" },
  buyer_type: "b2b",
  lines: [{ id: "1", description: "Consulting \"Q1\"", qty: 2, unit_minor: 50_000, net_minor: 100_000, hsn_sac: null, is_service: true, category: "AE", rate_bp: 0, tax_minor: 0, parts: [] }],
  tax_subtotals: [{ category: "AE", rate_bp: 0, taxable_minor: 100_000, tax_minor: 0 }],
  subtotal_minor: 100_000, tax_minor: 0, total_minor: 100_000, paid_minor: 0, reverse_charge: true,
  exempt_reason_code: "VATEX-EU-AE", exempt_reason_text: "Reverse charge: VAT to be accounted for by the recipient.", place_of_supply: "FR", supply_kind: "b2b_eu", notes: null, ...over,
});

describe("Peppol BIS 3.0 UBL", () => {
  it("matches the golden XML (reverse charge, escaping, namespaces)", () => {
    const r = buildPeppolUbl(euDoc());
    expect(r.ok).toBe(true);
    const xml = r.output ?? "";
    expect(xml).toContain('xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"');
    expect(xml).toContain("Acme &amp; Söhne GmbH");
    expect(xml).toContain("Société &lt;Exemple&gt;");
    expect(xml).toContain("Consulting &quot;Q1&quot;");
    expect(xml).toContain("<cbc:TaxExemptionReasonCode>VATEX-EU-AE</cbc:TaxExemptionReasonCode>");
    expect(xml).toContain('<cbc:PayableAmount currencyID="EUR">1000.00</cbc:PayableAmount>');
    const g = golden("peppol-reverse-charge.xml", xml);
    if (g !== null) expect(norm(xml)).toBe(norm(g));
  });

  it("standard-rated invoice with tax subtotals", () => {
    const doc = euDoc({
      reverse_charge: false, exempt_reason_code: null, exempt_reason_text: null, buyer_type: "b2c", buyer: { name: "Max", tax_id: null, country: "DE", address_line1: "x", city: "Köln", postal_code: "50667" },
      lines: [{ id: "1", description: "Widget", qty: 1, unit_minor: 10_000, net_minor: 10_000, hsn_sac: null, is_service: false, category: "S", rate_bp: 1900, tax_minor: 1900, parts: [{ name: "VAT", rate_bp: 1900, tax_minor: 1900 }] }],
      tax_subtotals: [{ category: "S", rate_bp: 1900, taxable_minor: 10_000, tax_minor: 1900 }], subtotal_minor: 10_000, tax_minor: 1900, total_minor: 11_900,
    });
    const r = buildPeppolUbl(doc);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("<cbc:Percent>19</cbc:Percent>");
    expect(r.output).toContain('<cbc:TaxInclusiveAmount currencyID="EUR">119.00</cbc:TaxInclusiveAmount>');
    expect(r.output).not.toContain("TaxExemptionReasonCode");
    const g = golden("peppol-standard.xml", r.output ?? "");
    if (g !== null) expect(norm(r.output ?? "")).toBe(norm(g));
  });

  it("lists every missing field", () => {
    const r = buildPeppolUbl(euDoc({ buyer: { name: "", tax_id: null, country: null, address_line1: null, city: null, postal_code: null }, seller: { name: "S", tax_id: null, country: "DE", address_line1: null, city: null, postal_code: null } }));
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(expect.arrayContaining(["Seller VAT identifier is missing (BT-31)", "Buyer name is missing (BT-44)", "Buyer country is missing (BT-55)", "Buyer VAT identifier is required for reverse-charge / intra-Community supplies (BT-48)"]));
  });

  it("credit notes use the CreditNote root and type 381", () => {
    const r = buildPeppolUbl(euDoc({ kind: "credit_note" }));
    expect(r.output).toContain("<CreditNote ");
    expect(r.output).toContain("<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>");
  });

  it("helpers", () => {
    expect(dec(5)).toBe("0.05");
    expect(dec(-12345)).toBe("-123.45");
    expect(xmlEscape(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;");
  });
});

const inDoc = (over: Partial<EDoc> = {}): EDoc => ({
  kind: "invoice", number: "INV-000007", issue_date: "2026-05-20", due_date: null, currency: "INR",
  seller: { name: "Kernel Traders", legal_name: "Kernel Traders Pvt Ltd", tax_id: "27AAPFU0939F1ZV", country: "IN", address_line1: "12 MG Road", city: "Mumbai", postal_code: "400001" },
  buyer: { name: "Bharat Retail", tax_id: "29AABCT1332L1ZA", country: "IN", address_line1: "5 Brigade Road", city: "Bengaluru", postal_code: "560001" },
  buyer_type: "b2b",
  lines: [
    { id: "1", description: "Steel bolts", qty: 10, unit_minor: 10_000, net_minor: 100_000, hsn_sac: "73181500", is_service: false, category: "S", rate_bp: 1800, tax_minor: 18_000, parts: [{ name: "IGST", rate_bp: 1800, tax_minor: 18_000 }] },
    { id: "2", description: "Installation", qty: 1, unit_minor: 50_000, net_minor: 50_000, hsn_sac: "9954", is_service: true, category: "S", rate_bp: 1800, tax_minor: 9000, parts: [{ name: "IGST", rate_bp: 1800, tax_minor: 9000 }] },
  ],
  tax_subtotals: [{ category: "S", rate_bp: 1800, taxable_minor: 150_000, tax_minor: 27_000 }],
  subtotal_minor: 150_000, tax_minor: 27_000, total_minor: 177_000, paid_minor: 0, reverse_charge: false, exempt_reason_code: null, exempt_reason_text: null,
  place_of_supply: "29", supply_kind: "inter", notes: null, ...over,
});

describe("India IRP JSON", () => {
  it("matches the golden payload for an inter-state B2B invoice", () => {
    const r = buildIrpJson(inDoc());
    expect(r.ok).toBe(true);
    const p = r.output!;
    expect(p.TranDtls).toEqual({ TaxSch: "GST", SupTyp: "B2B", RegRev: "N", IgstOnIntra: "N" });
    expect(p.DocDtls).toEqual({ Typ: "INV", No: "INV-000007", Dt: "20/05/2026" });
    expect(p.SellerDtls.Stcd).toBe("27");
    expect(p.BuyerDtls).toMatchObject({ Gstin: "29AABCT1332L1ZA", Pos: "29", Stcd: "29" });
    expect(p.ItemList[0]).toMatchObject({ HsnCd: "73181500", AssAmt: 1000, IgstAmt: 180, CgstAmt: 0, SgstAmt: 0, GstRt: 18, TotItemVal: 1180 });
    expect(p.ValDtls).toMatchObject({ AssVal: 1500, IgstVal: 270, TotInvVal: 1770, RndOffAmt: 0 });
    const text = JSON.stringify(p, null, 2);
    const g = golden("irp-inter-state.json", text);
    if (g !== null) expect(JSON.parse(g)).toEqual(p);
  });

  it("intra-state invoices carry CGST/SGST per item", () => {
    const r = buildIrpJson(inDoc({
      buyer: { name: "Local Co", tax_id: "27AAPFU0939F1ZV", country: "IN", address_line1: "a", city: "Pune", postal_code: "411001" }, place_of_supply: "27", supply_kind: "intra",
      lines: [{ id: "1", description: "Bolts", qty: 1, unit_minor: 100_000, net_minor: 100_000, hsn_sac: "7318", is_service: false, category: "S", rate_bp: 1800, tax_minor: 18_000, parts: [{ name: "CGST", rate_bp: 900, tax_minor: 9000 }, { name: "SGST", rate_bp: 900, tax_minor: 9000 }] }],
      subtotal_minor: 100_000, tax_minor: 18_000, total_minor: 118_000,
    }));
    expect(r.output?.ItemList[0]).toMatchObject({ CgstAmt: 90, SgstAmt: 90, IgstAmt: 0 });
    expect(r.output?.ValDtls).toMatchObject({ CgstVal: 90, SgstVal: 90, IgstVal: 0 });
  });

  it("reports each missing field (no buyer GSTIN, no HSN, bad PIN, B2C)", () => {
    const r = buildIrpJson(inDoc({ buyer: { name: "X", tax_id: null, country: "IN", address_line1: null, city: null, postal_code: "12" }, lines: [{ ...inDoc().lines[0], hsn_sac: null }], buyer_type: "b2c", place_of_supply: null }));
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(expect.arrayContaining([
      "Buyer GSTIN is missing (required for B2B e-invoices)", "Item 1 (Steel bolts): HSN/SAC code is missing", "Buyer PIN code must be 6 digits",
      "Place of supply (state code) is missing", "Buyer address line is missing",
    ]));
    expect(r.errors.some((e) => /B2C/.test(e))).toBe(true);
  });

  it("rejects an invalid seller GSTIN and over-long document numbers", () => {
    const r = buildIrpJson(inDoc({ number: "INVOICE-NUMBER-TOO-LONG", seller: { ...inDoc().seller, tax_id: "27AAPFU0939F1ZX" } }));
    expect(r.errors.join("|")).toMatch(/Seller GSTIN invalid/);
    expect(r.errors.join("|")).toMatch(/Document number/);
  });

  it("simulated submission is deterministic: IRN = sha256(GSTIN + FY + type + no)", () => {
    expect(financialYear("2026-05-20")).toBe("2026-27");
    expect(financialYear("2026-02-01")).toBe("2025-26");
    const p = buildIrpJson(inDoc()).output!;
    const a = simulateIrpSubmission(p, "2026-05-20", new Date("2026-05-21T10:00:00Z"));
    const b = simulateIrpSubmission(p, "2026-05-20", new Date("2026-05-21T10:00:00Z"));
    expect(a).toEqual(b);
    expect(a.irn).toMatch(/^[0-9a-f]{64}$/);
    expect(a.ack_dt).toBe("2026-05-21 10:00:00");
    expect(a.simulated).toBe(true);
    expect(JSON.parse(a.qr)).toMatchObject({ SellerGstin: "27AAPFU0939F1ZV", DocNo: "INV-000007", Irn: a.irn, Simulated: true });
  });
});
