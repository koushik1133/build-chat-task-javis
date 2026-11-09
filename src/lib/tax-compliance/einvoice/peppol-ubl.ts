import { validateEuVat, validateUkVat } from "../validators";
import type { BuildResult, EDoc, EParty } from "./types";

/**
 * EN 16931 / Peppol BIS Billing 3.0 UBL 2.1 invoice (generation only, no network).
 * Covers the mandatory core: parties, tax subtotals with category + exemption
 * reasons, payment means, legal monetary totals and invoice lines.
 */

const NS = {
  inv: "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
  cn: "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2",
  cac: "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
  cbc: "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
};
export const PEPPOL_CUSTOMIZATION = "urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0";
export const PEPPOL_PROFILE = "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0";

export function xmlEscape(s: string): string {
  // Drop characters that are illegal in XML 1.0 (control chars, lone surrogates) so user text can never make the document ill-formed.
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Minor units -> decimal string with two places (system-wide convention: 1 unit = 100 minor). */
export function dec(minor: number): string {
  const neg = minor < 0;
  const a = Math.abs(Math.round(minor));
  return `${neg ? "-" : ""}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}
const pct = (bp: number) => (bp / 100).toFixed(2).replace(/\.?0+$/, "") || "0";
const qty = (n: number) => String(Math.round(n * 1e6) / 1e6);

function vatId(p: EParty): { id: string; scheme: string } | null {
  if (!p.tax_id) return null;
  return { id: p.tax_id.replace(/\s/g, "").toUpperCase(), scheme: "VAT" };
}

function party(tag: string, p: EParty): string {
  const v = vatId(p);
  const endpoint = v ? `<cbc:EndpointID schemeID="9925">${xmlEscape(v.id)}</cbc:EndpointID>` : p.email ? `<cbc:EndpointID schemeID="EM">${xmlEscape(p.email)}</cbc:EndpointID>` : "";
  return `<cac:${tag}><cac:Party>${endpoint}<cac:PartyName><cbc:Name>${xmlEscape(p.name)}</cbc:Name></cac:PartyName>` +
    `<cac:PostalAddress>${p.address_line1 ? `<cbc:StreetName>${xmlEscape(p.address_line1)}</cbc:StreetName>` : ""}${p.city ? `<cbc:CityName>${xmlEscape(p.city)}</cbc:CityName>` : ""}${p.postal_code ? `<cbc:PostalZone>${xmlEscape(p.postal_code)}</cbc:PostalZone>` : ""}<cac:Country><cbc:IdentificationCode>${xmlEscape(p.country ?? "")}</cbc:IdentificationCode></cac:Country></cac:PostalAddress>` +
    (v ? `<cac:PartyTaxScheme><cbc:CompanyID>${xmlEscape(v.id)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>${v.scheme}</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>` : "") +
    `<cac:PartyLegalEntity><cbc:RegistrationName>${xmlEscape(p.legal_name ?? p.name)}</cbc:RegistrationName></cac:PartyLegalEntity>` +
    (p.email ? `<cac:Contact><cbc:ElectronicMail>${xmlEscape(p.email)}</cbc:ElectronicMail></cac:Contact>` : "") +
    `</cac:Party></cac:${tag}>`;
}

export function validateForPeppol(d: EDoc): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!d.number) errors.push("Invoice number is missing (BT-1)");
  if (!d.issue_date) errors.push("Issue date is missing (BT-2)");
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(d.issue_date) || (d.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(d.due_date))) errors.push("Dates must be YYYY-MM-DD");
  if (!/^[A-Z]{3}$/.test(d.currency)) errors.push("Document currency must be an ISO 4217 code (BT-5)");
  if (!d.seller.name) errors.push("Seller name is missing (BT-27)");
  if (!d.seller.country) errors.push("Seller country is missing (BT-40)");
  if (!d.seller.tax_id) errors.push("Seller VAT identifier is missing (BT-31)");
  else if (d.seller.country === "GB" ? !validateUkVat(d.seller.tax_id).valid : !validateEuVat(d.seller.tax_id).valid) warnings.push("Seller VAT identifier failed the format check");
  if (!d.seller.city) warnings.push("Seller city is missing (BT-37)");
  if (!d.buyer.name) errors.push("Buyer name is missing (BT-44)");
  if (!d.buyer.country) errors.push("Buyer country is missing (BT-55)");
  if (d.lines.length === 0) errors.push("At least one invoice line is required (BG-25)");
  const needsBuyerVat = d.lines.some((l) => l.category === "AE" || l.category === "K");
  if (needsBuyerVat && !d.buyer.tax_id) errors.push("Buyer VAT identifier is required for reverse-charge / intra-Community supplies (BT-48)");
  if (d.reverse_charge && !d.seller.tax_id) errors.push("Seller VAT identifier is required for reverse charge");
  if (!d.buyer.city) warnings.push("Buyer city is missing (BT-52)");
  if (!d.buyer_reference) warnings.push("Buyer reference (BT-10) is recommended by Peppol");
  return { errors, warnings };
}

export function buildPeppolUbl(d: EDoc): BuildResult<string> {
  const { errors, warnings } = validateForPeppol(d);
  if (errors.length > 0) return { ok: false, errors, warnings, output: null };
  const isCn = d.kind === "credit_note";
  const root = isCn ? "CreditNote" : "Invoice";
  const cur = xmlEscape(d.currency);
  const amt = (tag: string, minor: number) => `<cbc:${tag} currencyID="${cur}">${dec(minor)}</cbc:${tag}>`;

  const subtotals = d.tax_subtotals
    .map((t) => {
      const reason = t.category === "S" || t.category === "Z" ? "" : (d.exempt_reason_code ? `<cbc:TaxExemptionReasonCode>${xmlEscape(d.exempt_reason_code)}</cbc:TaxExemptionReasonCode>` : "") + (d.exempt_reason_text ? `<cbc:TaxExemptionReason>${xmlEscape(d.exempt_reason_text)}</cbc:TaxExemptionReason>` : "");
      return `<cac:TaxSubtotal>${amt("TaxableAmount", t.taxable_minor)}${amt("TaxAmount", t.tax_minor)}<cac:TaxCategory><cbc:ID>${t.category}</cbc:ID><cbc:Percent>${pct(t.rate_bp)}</cbc:Percent>${reason}<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>`;
    })
    .join("");

  const lines = d.lines
    .map((l, i) => {
      const reasonless = `<cac:ClassifiedTaxCategory><cbc:ID>${l.category}</cbc:ID><cbc:Percent>${pct(l.rate_bp)}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory>`;
      return `<cac:${isCn ? "CreditNoteLine" : "InvoiceLine"}><cbc:ID>${i + 1}</cbc:ID><cbc:${isCn ? "CreditedQuantity" : "InvoicedQuantity"} unitCode="C62">${qty(l.qty)}</cbc:${isCn ? "CreditedQuantity" : "InvoicedQuantity"}>${amt("LineExtensionAmount", l.net_minor)}` +
        `<cac:Item><cbc:Name>${xmlEscape(l.description.slice(0, 200))}</cbc:Name>${l.hsn_sac ? `<cac:CommodityClassification><cbc:ItemClassificationCode listID="HS">${xmlEscape(l.hsn_sac)}</cbc:ItemClassificationCode></cac:CommodityClassification>` : ""}${reasonless}</cac:Item>` +
        `<cac:Price>${amt("PriceAmount", l.unit_minor)}</cac:Price></cac:${isCn ? "CreditNoteLine" : "InvoiceLine"}>`;
    })
    .join("");

  const payable = Math.max(d.total_minor - d.paid_minor, 0);
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n<${root} xmlns="${isCn ? NS.cn : NS.inv}" xmlns:cac="${NS.cac}" xmlns:cbc="${NS.cbc}">` +
    `<cbc:CustomizationID>${PEPPOL_CUSTOMIZATION}</cbc:CustomizationID><cbc:ProfileID>${PEPPOL_PROFILE}</cbc:ProfileID>` +
    `<cbc:ID>${xmlEscape(d.number)}</cbc:ID><cbc:IssueDate>${d.issue_date}</cbc:IssueDate>${!isCn && d.due_date ? `<cbc:DueDate>${d.due_date}</cbc:DueDate>` : ""}` +
    `<cbc:${isCn ? "CreditNoteTypeCode" : "InvoiceTypeCode"}>${isCn ? "381" : "380"}</cbc:${isCn ? "CreditNoteTypeCode" : "InvoiceTypeCode"}>` +
    `${d.notes || d.exempt_reason_text ? `<cbc:Note>${xmlEscape([d.exempt_reason_text, d.notes].filter(Boolean).join(" | "))}</cbc:Note>` : ""}` +
    `<cbc:DocumentCurrencyCode>${cur}</cbc:DocumentCurrencyCode><cbc:BuyerReference>${xmlEscape(d.buyer_reference ?? d.number)}</cbc:BuyerReference>` +
    party("AccountingSupplierParty", d.seller) + party("AccountingCustomerParty", d.buyer) +
    `<cac:PaymentMeans><cbc:PaymentMeansCode>30</cbc:PaymentMeansCode><cbc:PaymentID>${xmlEscape(d.number)}</cbc:PaymentID>${d.payment_iban ? `<cac:PayeeFinancialAccount><cbc:ID>${xmlEscape(d.payment_iban)}</cbc:ID></cac:PayeeFinancialAccount>` : ""}</cac:PaymentMeans>` +
    `<cac:TaxTotal>${amt("TaxAmount", d.tax_minor)}${subtotals}</cac:TaxTotal>` +
    `<cac:LegalMonetaryTotal>${amt("LineExtensionAmount", d.subtotal_minor)}${amt("TaxExclusiveAmount", d.subtotal_minor)}${amt("TaxInclusiveAmount", d.total_minor)}${amt("PayableAmount", payable)}</cac:LegalMonetaryTotal>` +
    lines + `</${root}>\n`;
  return { ok: true, errors: [], warnings, output: xml };
}
