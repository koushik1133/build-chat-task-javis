import { createHash } from "crypto";
import { PdfDocument, type PdfPage, type Rgb } from "./writer";

/**
 * Quote / invoice PDF renderers (pure: no DB, no clock).
 *
 * `renderQuotePdf(quote, null, …)` is the unsigned document; its SHA-256 is the
 * fingerprint stored at acceptance time. `renderQuotePdf(quote, stamp, …)`
 * appends the e-signature block (signer, typed signature, timestamps, IP/UA,
 * consent text + terms version and the unsigned fingerprint). Rendering is
 * deterministic so the stamped bytes can be re-produced and re-hashed later.
 */

export interface DocLineItem {
  description: string;
  qty: number;
  unit_minor: number;
  tax_rate_bp?: number;
  tax_rate_id?: string | null;
  tax_rate_ids?: string[];
}

export interface DocTaxRow {
  name: string;
  rate_bp: number;
  taxable_minor: number;
  tax_minor: number;
}

/** Party details printed under the names (issuer and customer). */
export interface DocParties {
  /** e.g. "VAT ID: GB123" — label + number of the issuing business. */
  issuer_tax_label?: string | null;
  issuer_tax_number?: string | null;
  contact_tax_number?: string | null;
  /** Free text or JSON address object ({line1, line2, city, region, postal_code, country}). */
  contact_billing_address?: string | null;
  /** Labels for tax rates referenced by line items (id → "GST 10%"). */
  rate_labels?: Record<string, string>;
}

/** Turn a stored billing address (JSON object or plain text) into printable lines. */
export function addressLines(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const t = raw.trim();
  if (!t) return [];
  if (t.startsWith("{")) {
    try {
      const o = JSON.parse(t) as Record<string, unknown>;
      const pick = (k: string) => (typeof o[k] === "string" && (o[k] as string).trim() ? (o[k] as string).trim() : null);
      const cityLine = [pick("city"), pick("region"), pick("postal_code") ?? pick("postcode") ?? pick("zip")].filter(Boolean).join(", ");
      return [pick("line1") ?? pick("street"), pick("line2"), cityLine || null, pick("country")].filter((x): x is string => Boolean(x));
    } catch {
      /* plain text below */
    }
  }
  return t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 6);
}

export interface QuoteDocInput {
  number: string;
  status: string;
  currency: string;
  items: DocLineItem[];
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
  valid_until: string | null;
  terms_version: string | null;
  terms_text: string | null;
  notes: string | null;
  contact_name: string | null;
  contact_email?: string | null;
  created_at: string;
  sent_at?: string | null;
  accepted_at?: string | null;
  current_version?: number;
  tax_breakdown?: DocTaxRow[];
  parties?: DocParties;
}

export interface InvoiceDocInput {
  number: string;
  status: string;
  currency: string;
  items: DocLineItem[];
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
  paid_minor: number;
  due_at: string | null;
  notes: string | null;
  contact_name: string | null;
  contact_email?: string | null;
  created_at: string;
  sent_at?: string | null;
  paid_at?: string | null;
  quote_number?: string | null;
  tax_breakdown?: DocTaxRow[];
  parties?: DocParties;
  terms_days?: number | null;
}

/** Everything stamped onto an accepted quote. */
export interface SignatureStamp {
  name: string;
  email: string;
  signature_text: string | null;
  /** ISO timestamp of acceptance. */
  signed_at: string;
  ip: string | null;
  user_agent: string | null;
  consent_terms_version: string | null;
  consent_terms_text: string | null;
  /** SHA-256 hex of the unsigned document bytes. */
  document_hash: string;
}

export interface DocBranding {
  brand_name: string;
  support_email?: string | null;
  primary_color?: string | null;
}

export interface RenderOptions {
  /** Public copies: print "IP and device recorded" instead of the raw IP / user agent. */
  redactEvidence?: boolean;
  /** IANA zone for the "local" timestamp in the signature block. */
  timezone?: string | null;
  /** Name of the issuing business when branding has none. */
  business?: string | null;
}

export const CONSENT_TEXT =
  "The signer confirmed their email address with a one-time code and typed their name as an electronic signature, " +
  "agreeing to be bound by this document and the terms shown. This electronic record and signature are intended to " +
  "have the same legal effect as a handwritten signature.";

/* ─── helpers ────────────────────────────────────────────────────────────── */

export const INK: Rgb = [0.1, 0.1, 0.12];
export const MUTED: Rgb = [0.45, 0.45, 0.5];
export const RULE: Rgb = [0.82, 0.82, 0.85];
export const PANEL: Rgb = [0.96, 0.96, 0.97];

export function documentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function fmtMinor(minor: number, currency: string): string {
  const n = (Number(minor) || 0) / 100;
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const [int, frac] = abs.toFixed(2).split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${grouped}.${frac} ${currency}`;
}

function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function fmtDateOnly(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

/** "2026-11-02 14:05:09 UTC" or the same instant in `tz` with its short zone name. */
export function fmtInstant(iso: string, tz: string | null | undefined): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const zone = tz && isValidTz(tz) ? tz : "UTC";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")} ${get("timeZoneName") || zone}`;
}

function hexColor(c: string | null | undefined): Rgb | null {
  if (!c || !/^#[0-9a-f]{6}$/i.test(c)) return null;
  return [parseInt(c.slice(1, 3), 16) / 255, parseInt(c.slice(3, 5), 16) / 255, parseInt(c.slice(5, 7), 16) / 255];
}

/** Simple flowing layout cursor with automatic page breaks. */
export class Flow {
  page: PdfPage;
  y: number;
  readonly margin = 48;
  readonly top = 48;
  readonly bottom = 64;
  constructor(
    readonly doc: PdfDocument,
    private readonly onNewPage: (p: PdfPage) => number
  ) {
    this.page = doc.addPage();
    this.y = this.onNewPage(this.page);
  }
  get width(): number {
    return this.doc.width - this.margin * 2;
  }
  get right(): number {
    return this.doc.width - this.margin;
  }
  ensure(space: number): void {
    if (this.y + space > this.doc.height - this.bottom) {
      this.page = this.doc.addPage();
      this.y = this.onNewPage(this.page);
    }
  }
  gap(n: number): void {
    this.y += n;
  }
}

export interface HeaderSpec {
  brand: string;
  kindLabel: string;
  number: string;
  accent: Rgb;
  meta: Array<[string, string]>;
}

export function drawHeader(page: PdfPage, spec: HeaderSpec, margin: number): number {
  const right = page.width - margin;
  page.rect(0, 0, page.width, 6, { fill: spec.accent });
  page.text(margin, 48 + 14, spec.brand, { size: 16, font: "Helvetica-Bold", color: INK });
  page.text(right, 48 + 14, spec.kindLabel, { size: 22, font: "Helvetica-Bold", color: spec.accent, align: "right" });
  page.text(right, 48 + 30, spec.number, { size: 11, font: "Helvetica", color: MUTED, align: "right" });
  let y = 48 + 48;
  for (const [k, v] of spec.meta) {
    page.text(right - 120, y, k, { size: 9, color: MUTED, align: "right" });
    page.text(right, y, v, { size: 9, color: INK, align: "right" });
    y += 13;
  }
  page.line(margin, y + 4, right, y + 4, { color: RULE });
  return y + 20;
}

export function drawFooters(doc: PdfDocument, label: string, margin: number): void {
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.line(margin, p.height - 44, p.width - margin, p.height - 44, { color: RULE });
    p.text(margin, p.height - 30, label, { size: 8, color: MUTED });
    p.text(p.width - margin, p.height - 30, `Page ${i + 1} of ${pages.length}`, { size: 8, color: MUTED, align: "right" });
  });
}

export function drawParty(flow: Flow, title: string, lines: string[]): void {
  const clean = lines.filter((l) => l && l.trim());
  if (clean.length === 0) return;
  flow.ensure(16 + clean.length * 13);
  flow.page.text(flow.margin, flow.y, title.toUpperCase(), { size: 8, font: "Helvetica-Bold", color: MUTED });
  flow.y += 13;
  for (const l of clean) {
    flow.page.text(flow.margin, flow.y, l, { size: 10, color: INK });
    flow.y += 13;
  }
  flow.gap(8);
}

export const COLS = { qty: 60, unit: 90, tax: 80, amount: 100 } as const;

function lineTaxLabel(it: DocLineItem, labels?: Record<string, string>): string {
  const ids = it.tax_rate_ids && it.tax_rate_ids.length > 0 ? it.tax_rate_ids : it.tax_rate_id ? [it.tax_rate_id] : [];
  const named = ids.map((id) => labels?.[id]).filter((x): x is string => Boolean(x));
  if (named.length > 0) return named.join(" + ");
  return `${((it.tax_rate_bp ?? 0) / 100).toFixed(2)}%`;
}

export function drawItemsTable(flow: Flow, items: DocLineItem[], currency: string, rateLabels?: Record<string, string>): void {
  const x0 = flow.margin;
  const xAmount = flow.right;
  const xTax = xAmount - COLS.amount;
  const xUnit = xTax - COLS.tax;
  const xQty = xUnit - COLS.unit;
  const descWidth = xQty - COLS.qty - x0 - 8;

  const header = () => {
    flow.ensure(24);
    flow.page.rect(x0, flow.y - 11, flow.width, 18, { fill: PANEL });
    flow.page.text(x0 + 6, flow.y + 1, "DESCRIPTION", { size: 8, font: "Helvetica-Bold", color: MUTED });
    flow.page.text(xQty, flow.y + 1, "QTY", { size: 8, font: "Helvetica-Bold", color: MUTED, align: "right" });
    flow.page.text(xUnit, flow.y + 1, "UNIT", { size: 8, font: "Helvetica-Bold", color: MUTED, align: "right" });
    flow.page.text(xTax, flow.y + 1, "TAX", { size: 8, font: "Helvetica-Bold", color: MUTED, align: "right" });
    flow.page.text(xAmount, flow.y + 1, "AMOUNT", { size: 8, font: "Helvetica-Bold", color: MUTED, align: "right" });
    flow.y += 18;
  };
  header();

  if (items.length === 0) {
    flow.page.text(x0 + 6, flow.y + 4, "No line items", { size: 10, color: MUTED });
    flow.y += 20;
  }

  for (const it of items) {
    const lineMinor = Math.floor(Number(it.qty) * Number(it.unit_minor) + 0.5);
    const needed = 16 * Math.max(1, Math.ceil(it.description.length / 60)) + 8;
    const before = flow.y;
    flow.ensure(needed);
    if (flow.y !== before) header();
    const { nextY } = flow.page.textBlock(x0 + 6, flow.y + 4, it.description, { size: 10, maxWidth: descWidth, lineHeight: 13, color: INK });
    flow.page.text(xQty, flow.y + 4, String(Number(it.qty)), { size: 10, align: "right", color: INK });
    flow.page.text(xUnit, flow.y + 4, fmtMinor(it.unit_minor, currency), { size: 10, align: "right", color: INK });
    flow.page.text(xTax, flow.y + 4, lineTaxLabel(it, rateLabels), { size: 8.5, align: "right", color: INK });
    flow.page.text(xAmount, flow.y + 4, fmtMinor(lineMinor, currency), { size: 10, align: "right", color: INK });
    flow.y = Math.max(nextY, flow.y + 13) + 4;
    flow.page.line(x0, flow.y - 4, flow.right, flow.y - 4, { color: RULE });
  }
}

export function drawTotals(flow: Flow, rows: Array<[string, string, boolean?]>): void {
  flow.ensure(rows.length * 16 + 10);
  const labelX = flow.right - COLS.amount - 10;
  for (const [label, value, bold] of rows) {
    flow.page.text(labelX, flow.y + 4, label, { size: bold ? 11 : 10, font: bold ? "Helvetica-Bold" : "Helvetica", color: bold ? INK : MUTED, align: "right" });
    flow.page.text(flow.right, flow.y + 4, value, { size: bold ? 11 : 10, font: bold ? "Helvetica-Bold" : "Helvetica", color: INK, align: "right" });
    flow.y += 16;
  }
  flow.gap(10);
}

export function drawSection(flow: Flow, title: string, body: string, opts: { size?: number } = {}): void {
  const text = body.trim();
  if (!text) return;
  flow.ensure(40);
  flow.page.text(flow.margin, flow.y, title.toUpperCase(), { size: 8, font: "Helvetica-Bold", color: MUTED });
  flow.y += 13;
  // Paragraph by paragraph so page breaks land between lines, not mid-block.
  for (const para of text.split(/\n{2,}/)) {
    const size = opts.size ?? 9.5;
    const lines = para.split("\n");
    for (const line of lines) {
      flow.ensure(size * 1.4);
      const { nextY } = flow.page.textBlock(flow.margin, flow.y, line, { size, maxWidth: flow.width, lineHeight: size * 1.4, color: INK });
      // textBlock may wrap to several lines; recheck bounds for the next one.
      flow.y = nextY;
    }
    flow.gap(6);
  }
  flow.gap(6);
}

export const REDACTED_EVIDENCE = "IP and device recorded";

function drawSignature(flow: Flow, stamp: SignatureStamp, tz: string | null | undefined, redact = false): void {
  const x = flow.margin;
  const inner = x + 12;
  const labelW = 110;
  const valueX = inner + labelW;
  const valueW = flow.width - labelW - 24;

  const rows: Array<[string, string, { font?: "Helvetica-Oblique"; size?: number }?]> = [
    ["Signed by", `${stamp.name} <${stamp.email}>`],
    ["Signature", stamp.signature_text?.trim() || stamp.name, { font: "Helvetica-Oblique", size: 15 }],
    ["Signed at (UTC)", fmtInstant(stamp.signed_at, "UTC")],
  ];
  if (tz && tz !== "UTC") rows.push([`Signed at (${tz})`, fmtInstant(stamp.signed_at, tz)]);
  if (redact) {
    rows.push(["Evidence", REDACTED_EVIDENCE]);
  } else {
    rows.push(["IP address", stamp.ip || "—"]);
    rows.push(["User agent", stamp.user_agent || "—"]);
  }
  rows.push(["Terms version", stamp.consent_terms_version || "—"]);
  rows.push(["Consent", CONSENT_TEXT]);
  rows.push(["Document SHA-256", stamp.document_hash]);

  // Measure first so the panel height is exact.
  const measure = new PdfDocument({ width: flow.doc.width, height: flow.doc.height }).addPage();
  let h = 20;
  for (const [, value, o] of rows) {
    const size = o?.size ?? 9.5;
    const r = measure.textBlock(0, 0, value, { size, font: o?.font, maxWidth: valueW, lineHeight: size * 1.3 });
    h += Math.max(size * 1.3, r.nextY) + 4;
  }
  h += 24;
  flow.ensure(h);
  const top = flow.y;
  let y = top + 20;
  flow.page.rect(x, top, flow.width, h, { fill: PANEL, stroke: RULE });
  flow.page.text(inner, y, "ELECTRONICALLY ACCEPTED AND SIGNED", { size: 9, font: "Helvetica-Bold", color: [0.05, 0.45, 0.25] });
  y += 18;
  for (const [label, value, o] of rows) {
    const size = o?.size ?? 9.5;
    flow.page.text(inner, y, label, { size: 8.5, color: MUTED });
    const r = flow.page.textBlock(valueX, y, value, { size, font: o?.font, maxWidth: valueW, lineHeight: size * 1.3, color: INK });
    y = Math.max(y + size * 1.3, r.nextY) + 4;
  }
  flow.y = top + h + 12;
}

/** Totals rows: one line per tax rate when a breakdown exists, else a single "Tax" line. */
export function taxRows(taxMinor: number, currency: string, breakdown?: DocTaxRow[]): Array<[string, string, boolean?]> {
  if (!breakdown || breakdown.length === 0) return [["Tax", fmtMinor(taxMinor, currency)]];
  return breakdown.map((b) => [`${b.name} ${(b.rate_bp / 100).toFixed(2).replace(/\.?0+$/, "")}% on ${fmtMinor(b.taxable_minor, currency)}`, fmtMinor(b.tax_minor, currency)]);
}

export function issuerLines(p?: DocParties): string[] {
  if (!p?.issuer_tax_number) return [];
  return [`${p.issuer_tax_label?.trim() || "Tax ID"}: ${p.issuer_tax_number}`];
}

export function customerLines(name: string | null | undefined, email: string | null | undefined, p?: DocParties): string[] {
  return [name ?? "", email ?? "", ...addressLines(p?.contact_billing_address), p?.contact_tax_number ? `Tax ID: ${p.contact_tax_number}` : ""];
}

/* ─── public renderers ───────────────────────────────────────────────────── */

export function renderQuotePdf(quote: QuoteDocInput, stamp: SignatureStamp | null, branding: DocBranding, opts: RenderOptions = {}): Uint8Array {
  const brand = branding.brand_name?.trim() || opts.business?.trim() || "Quote";
  const accent = hexColor(branding.primary_color) ?? [0.97, 0.45, 0.09];
  const doc = new PdfDocument({ title: `Quote ${quote.number}`, author: brand, subject: `Quote ${quote.number}${stamp ? " (signed)" : ""}` });
  const statusLabel = stamp ? "accepted" : quote.status;
  const meta: Array<[string, string]> = [
    ["Date", fmtDateOnly(quote.sent_at ?? quote.created_at)],
    ["Valid until", fmtDateOnly(quote.valid_until)],
    ["Status", statusLabel.replace(/_/g, " ")],
  ];
  if (quote.current_version && quote.current_version > 1) meta.push(["Revision", String(quote.current_version)]);

  const flow = new Flow(doc, (p) => drawHeader(p, { brand, kindLabel: "QUOTE", number: quote.number, accent, meta }, 48));

  if (issuerLines(quote.parties).length) drawParty(flow, "From", [brand, ...issuerLines(quote.parties)]);
  drawParty(flow, "Prepared for", customerLines(quote.contact_name, quote.contact_email, quote.parties));
  drawItemsTable(flow, quote.items, quote.currency, quote.parties?.rate_labels);
  flow.gap(6);
  drawTotals(flow, [
    ["Subtotal", fmtMinor(quote.subtotal_minor, quote.currency)],
    ...taxRows(quote.tax_minor, quote.currency, quote.tax_breakdown),
    ["Total", fmtMinor(quote.total_minor, quote.currency), true],
  ]);
  if (quote.notes) drawSection(flow, "Notes", quote.notes);
  if (quote.terms_text) drawSection(flow, `Terms${quote.terms_version ? ` (${quote.terms_version})` : ""}`, quote.terms_text, { size: 8.5 });
  if (stamp) drawSignature(flow, stamp, opts.timezone, opts.redactEvidence === true);

  const footer = [brand, branding.support_email ? branding.support_email : null, stamp ? `Signed copy · fingerprint ${stamp.document_hash.slice(0, 16)}…` : `Quote ${quote.number}`]
    .filter(Boolean)
    .join("  ·  ");
  drawFooters(doc, footer, 48);
  return doc.render();
}

export function renderInvoicePdf(invoice: InvoiceDocInput, branding: DocBranding, opts: RenderOptions = {}): Uint8Array {
  const brand = branding.brand_name?.trim() || opts.business?.trim() || "Invoice";
  const accent = hexColor(branding.primary_color) ?? [0.97, 0.45, 0.09];
  const doc = new PdfDocument({ title: `Invoice ${invoice.number}`, author: brand, subject: `Invoice ${invoice.number}` });
  const meta: Array<[string, string]> = [
    ["Date", fmtDateOnly(invoice.sent_at ?? invoice.created_at)],
    ["Due", fmtDateOnly(invoice.due_at)],
    ["Status", invoice.status.replace(/_/g, " ")],
  ];
  if (invoice.quote_number) meta.push(["Quote", invoice.quote_number]);
  if (invoice.terms_days !== null && invoice.terms_days !== undefined) meta.push(["Terms", invoice.terms_days === 0 ? "Due on receipt" : `Net ${invoice.terms_days}`]);

  const flow = new Flow(doc, (p) => drawHeader(p, { brand, kindLabel: "INVOICE", number: invoice.number, accent, meta }, 48));
  if (issuerLines(invoice.parties).length) drawParty(flow, "From", [brand, ...issuerLines(invoice.parties)]);
  drawParty(flow, "Billed to", customerLines(invoice.contact_name, invoice.contact_email, invoice.parties));
  drawItemsTable(flow, invoice.items, invoice.currency, invoice.parties?.rate_labels);
  flow.gap(6);
  const outstanding = Math.max(invoice.total_minor - invoice.paid_minor, 0);
  const rows: Array<[string, string, boolean?]> = [
    ["Subtotal", fmtMinor(invoice.subtotal_minor, invoice.currency)],
    ...taxRows(invoice.tax_minor, invoice.currency, invoice.tax_breakdown),
    ["Total", fmtMinor(invoice.total_minor, invoice.currency), true],
  ];
  if (invoice.paid_minor > 0) {
    rows.push(["Paid", fmtMinor(invoice.paid_minor, invoice.currency)]);
    rows.push(["Balance due", fmtMinor(outstanding, invoice.currency), true]);
  }
  drawTotals(flow, rows);
  if (invoice.status === "paid" && invoice.paid_at) {
    flow.ensure(20);
    flow.page.text(flow.margin, flow.y, `Paid in full on ${fmtDateOnly(invoice.paid_at)}. Thank you.`, { size: 10, font: "Helvetica-Bold", color: [0.05, 0.45, 0.25] });
    flow.gap(20);
  }
  if (invoice.notes) drawSection(flow, "Notes", invoice.notes);
  const footer = [brand, branding.support_email ?? null, `Invoice ${invoice.number}`].filter(Boolean).join("  ·  ");
  drawFooters(doc, footer, 48);
  return doc.render();
}
