import { PdfDocument } from "./writer";
import {
  Flow,
  INK,
  MUTED,
  PANEL,
  RULE,
  customerLines,
  drawFooters,
  drawHeader,
  drawItemsTable,
  drawParty,
  drawSection,
  drawTotals,
  fmtDateOnly,
  fmtMinor,
  issuerLines,
  taxRows,
  type DocBranding,
  type DocLineItem,
  type DocParties,
  type DocTaxRow,
  type RenderOptions,
} from "./quote-document";

/** Credit note and customer statement PDFs (pure renderers, same look as quotes/invoices). */

export interface CreditNoteDocInput {
  number: string;
  status: string;
  currency: string;
  items: DocLineItem[];
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
  tax_breakdown?: DocTaxRow[];
  reason: string | null;
  invoice_number: string | null;
  contact_name: string | null;
  contact_email?: string | null;
  created_at: string;
  issued_at: string | null;
  parties?: DocParties;
}

function hexColor(c: string | null | undefined): readonly [number, number, number] | null {
  if (!c || !/^#[0-9a-f]{6}$/i.test(c)) return null;
  return [parseInt(c.slice(1, 3), 16) / 255, parseInt(c.slice(3, 5), 16) / 255, parseInt(c.slice(5, 7), 16) / 255];
}

export function renderCreditNotePdf(note: CreditNoteDocInput, branding: DocBranding, opts: RenderOptions = {}): Uint8Array {
  const brand = branding.brand_name?.trim() || opts.business?.trim() || "Credit note";
  const accent = hexColor(branding.primary_color) ?? [0.97, 0.45, 0.09];
  const doc = new PdfDocument({ title: `Credit note ${note.number}`, author: brand, subject: `Credit note ${note.number}` });
  const meta: Array<[string, string]> = [
    ["Date", fmtDateOnly(note.issued_at ?? note.created_at)],
    ["Status", note.status.replace(/_/g, " ")],
  ];
  if (note.invoice_number) meta.push(["Against invoice", note.invoice_number]);
  const flow = new Flow(doc, (p) => drawHeader(p, { brand, kindLabel: "CREDIT NOTE", number: note.number, accent, meta }, 48));
  if (issuerLines(note.parties).length) drawParty(flow, "From", [brand, ...issuerLines(note.parties)]);
  drawParty(flow, "Credited to", customerLines(note.contact_name, note.contact_email, note.parties));
  drawItemsTable(flow, note.items, note.currency, note.parties?.rate_labels);
  flow.gap(6);
  drawTotals(flow, [
    ["Subtotal", fmtMinor(note.subtotal_minor, note.currency)],
    ...taxRows(note.tax_minor, note.currency, note.tax_breakdown),
    ["Total credit", fmtMinor(note.total_minor, note.currency), true],
  ]);
  if (note.reason) drawSection(flow, "Reason", note.reason);
  drawFooters(doc, [brand, branding.support_email ?? null, `Credit note ${note.number}`].filter(Boolean).join("  ·  "), 48);
  return doc.render();
}

export interface StatementDocInput {
  contact: { name: string; email: string | null; company: string | null; tax_number: string | null; billing_address: string | null };
  from: string;
  to: string;
  entries: Array<{ date: string; kind: string; ref: string; description: string; currency: string; amount_minor: number; running_minor: number }>;
  balances: Array<{ currency: string; opening_minor: number; invoiced_minor: number; paid_minor: number; credited_minor: number; refunded_minor: number; closing_minor: number }>;
  generated_at: string;
  parties?: DocParties;
}

export function renderStatementPdf(st: StatementDocInput, branding: DocBranding, opts: RenderOptions = {}): Uint8Array {
  const brand = branding.brand_name?.trim() || opts.business?.trim() || "Statement";
  const accent = hexColor(branding.primary_color) ?? [0.97, 0.45, 0.09];
  const doc = new PdfDocument({ title: `Statement for ${st.contact.name}`, author: brand, subject: "Customer statement" });
  const meta: Array<[string, string]> = [
    ["Period", `${fmtDateOnly(st.from)} to ${fmtDateOnly(st.to)}`],
    ["Generated", fmtDateOnly(st.generated_at)],
  ];
  const flow = new Flow(doc, (p) => drawHeader(p, { brand, kindLabel: "STATEMENT", number: st.contact.name, accent, meta }, 48));
  if (issuerLines(st.parties).length) drawParty(flow, "From", [brand, ...issuerLines(st.parties)]);
  drawParty(flow, "Customer", customerLines(st.contact.name, st.contact.email, { contact_tax_number: st.contact.tax_number, contact_billing_address: st.contact.billing_address }).concat(st.contact.company ? [st.contact.company] : []));

  for (const b of st.balances) {
    const rows = st.entries.filter((e) => e.currency === b.currency);
    flow.ensure(40);
    flow.page.text(flow.margin, flow.y, `${b.currency} ACCOUNT`, { size: 8, font: "Helvetica-Bold", color: MUTED });
    flow.y += 14;

    const x0 = flow.margin;
    const xBal = flow.right;
    const xAmt = xBal - 100;
    const xRef = x0 + 70;
    const xDesc = xRef + 90;
    const header = () => {
      flow.ensure(24);
      flow.page.rect(x0, flow.y - 11, flow.width, 18, { fill: PANEL });
      flow.page.text(x0 + 6, flow.y + 1, "DATE", { size: 8, font: "Helvetica-Bold", color: MUTED });
      flow.page.text(xRef, flow.y + 1, "REF", { size: 8, font: "Helvetica-Bold", color: MUTED });
      flow.page.text(xDesc, flow.y + 1, "DESCRIPTION", { size: 8, font: "Helvetica-Bold", color: MUTED });
      flow.page.text(xAmt, flow.y + 1, "AMOUNT", { size: 8, font: "Helvetica-Bold", color: MUTED, align: "right" });
      flow.page.text(xBal, flow.y + 1, "BALANCE", { size: 8, font: "Helvetica-Bold", color: MUTED, align: "right" });
      flow.y += 18;
    };
    header();
    const line = (date: string, ref: string, desc: string, amount: string, bal: string, bold = false) => {
      const before = flow.y;
      flow.ensure(18);
      if (flow.y !== before) header();
      const font = bold ? "Helvetica-Bold" : "Helvetica";
      flow.page.text(x0 + 6, flow.y + 4, date, { size: 9, color: INK, font });
      flow.page.text(xRef, flow.y + 4, ref, { size: 9, color: INK, font });
      flow.page.textBlock(xDesc, flow.y + 4, desc, { size: 9, color: INK, font, maxWidth: xAmt - xDesc - 110, lineHeight: 11 });
      flow.page.text(xAmt, flow.y + 4, amount, { size: 9, color: INK, align: "right", font });
      flow.page.text(xBal, flow.y + 4, bal, { size: 9, color: INK, align: "right", font });
      flow.y += 17;
      flow.page.line(x0, flow.y - 4, flow.right, flow.y - 4, { color: RULE });
    };
    line(fmtDateOnly(st.from), "", "Opening balance", "", fmtMinor(b.opening_minor, b.currency), true);
    for (const e of rows) line(fmtDateOnly(e.date), e.ref, e.description, fmtMinor(e.amount_minor, b.currency), fmtMinor(e.running_minor, b.currency));
    line(fmtDateOnly(st.to), "", "Closing balance", "", fmtMinor(b.closing_minor, b.currency), true);
    flow.gap(8);
    drawTotals(flow, [
      ["Invoiced", fmtMinor(b.invoiced_minor, b.currency)],
      ["Paid", fmtMinor(-b.paid_minor, b.currency)],
      ["Credited", fmtMinor(-b.credited_minor, b.currency)],
      ...(b.refunded_minor > 0 ? ([["Refunded", fmtMinor(b.refunded_minor, b.currency)]] as Array<[string, string, boolean?]>) : []),
      [b.closing_minor > 0 ? "Amount due" : "Balance", fmtMinor(b.closing_minor, b.currency), true],
    ]);
  }
  if (st.balances.length === 0) {
    flow.ensure(20);
    flow.page.text(flow.margin, flow.y, "No invoices, payments or credits in this period.", { size: 10, color: MUTED });
    flow.gap(20);
  }
  drawFooters(doc, [brand, branding.support_email ?? null, "Customer statement"].filter(Boolean).join("  ·  "), 48);
  return doc.render();
}
