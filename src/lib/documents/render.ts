import { PdfDocument, measureText, type PdfFont, type Rgb } from "@/lib/pdf/writer";
import { CONSENT_TEXT, Flow, INK, MUTED, PANEL, RULE, documentHash, drawFooters, drawHeader, fmtDateOnly, fmtInstant } from "@/lib/pdf/quote-document";
import { emailHint, type DocumentKind, type MergeField } from "./types";

/**
 * Pure rendering for documents: merge-field substitution, a small markdown
 * parser and a deterministic markdown → PDF renderer built on the
 * dependency-free writer. No DB, no clock (timestamps come from the input).
 */

/* ─── merge fields ───────────────────────────────────────────────────────── */

const MERGE_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

/** Every `{{key}}` referenced by a body, in order of first appearance. */
export function extractMergeKeys(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(MERGE_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/**
 * Merged values are *content*, never markup: markdown-significant characters
 * at the start of a line and inline emphasis markers are escaped so a value
 * like "# Boss" or "**free**" renders literally. A `{{` inside a value can
 * never be re-expanded because substitution is single-pass.
 */
export function escapeMergeValue(v: string): string {
  return v
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) =>
      line
        .replace(/\*/g, "\\*")
        .replace(/^(\s*)([#>\-+]|\d+[.)])(\s)/, "$1\\$2$3")
        // a value line of only ---/___ would otherwise render as a horizontal rule
        .replace(/^(\s*)([-_])(?=[-_]{2,}\s*$)/, "$1\\$2")
        .replace(/\|/g, "\\|")
    )
    .join("\n");
}

export interface MergeResult {
  body: string;
  missing: string[];
}

/** Substitute `{{key}}` with escaped values; unknown keys render as a visible blank "______" and are reported. */
export function renderMerge(body: string, data: Record<string, string | null | undefined>): MergeResult {
  const missing: string[] = [];
  const out = body.replace(MERGE_RE, (_m, key: string) => {
    const v = data[key];
    if (v === undefined || v === null || String(v).trim() === "") {
      if (!missing.includes(key)) missing.push(key);
      return "______";
    }
    return escapeMergeValue(String(v));
  });
  return { body: out, missing };
}

/** Required fields that are blank in `data`. */
export function missingRequired(fields: MergeField[], data: Record<string, string | null | undefined>): string[] {
  return fields.filter((f) => f.required && !(data[f.key] ?? "").toString().trim()).map((f) => f.key);
}

/* ─── markdown subset ────────────────────────────────────────────────────── */

export type InlineRun = { text: string; bold: boolean };

export type MdBlock =
  | { type: "heading"; level: 1 | 2 | 3; runs: InlineRun[] }
  | { type: "paragraph"; runs: InlineRun[] }
  | { type: "list"; ordered: boolean; items: InlineRun[][] }
  | { type: "table"; rows: string[][] }
  | { type: "rule" };

/** `**bold**` runs; backslash escapes `\*`, `\#`, `\|`, `\-` to literals. */
export function parseInline(text: string): InlineRun[] {
  const runs: InlineRun[] = [];
  let bold = false;
  let buf = "";
  const flush = () => {
    if (buf) runs.push({ text: buf, bold });
    buf = "";
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      buf += text[i + 1];
      i++;
      continue;
    }
    if (ch === "*" && text[i + 1] === "*") {
      flush();
      bold = !bold;
      i++;
      continue;
    }
    buf += ch;
  }
  flush();
  return runs.length ? runs : [{ text: "", bold: false }];
}

export function parseMarkdown(md: string): MdBlock[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let table: string[][] | null = null;

  const flushPara = () => {
    if (para.length) blocks.push({ type: "paragraph", runs: parseInline(para.join(" ")) });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push({ type: "list", ordered: list.ordered, items: list.items.map(parseInline) });
    list = null;
  };
  const flushTable = () => {
    if (table && table.length) blocks.push({ type: "table", rows: table });
    table = null;
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushTable();
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      flushAll();
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      blocks.push({ type: "heading", level: heading[1].length as 1 | 2 | 3, runs: parseInline(heading[2]) });
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushAll();
      blocks.push({ type: "rule" });
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushPara();
      flushTable();
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((bullet ?? numbered)![1]);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushPara();
      flushList();
      const cells = line.trim().slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // alignment row
      table = table ?? [];
      table.push(cells);
      continue;
    }
    if (list && /^\s{2,}\S/.test(raw)) {
      // continuation line of a list item
      list.items[list.items.length - 1] += " " + line.trim();
      continue;
    }
    flushList();
    flushTable();
    para.push(line.trim());
  }
  flushAll();
  return blocks;
}

/** Plain text of a block list (search indexing, previews). */
export function markdownToText(md: string): string {
  return parseMarkdown(md)
    .map((b) => {
      if (b.type === "rule") return "";
      if (b.type === "table") return b.rows.map((r) => r.join(" | ")).join("\n");
      if (b.type === "list") return b.items.map((i) => "- " + i.map((r) => r.text).join("")).join("\n");
      return b.runs.map((r) => r.text).join("");
    })
    .join("\n\n");
}

/* ─── PDF ────────────────────────────────────────────────────────────────── */

export interface SignerStamp {
  name: string;
  email: string;
  role: string | null;
  signature_text: string | null;
  signed_at: string;
  ip: string | null;
  user_agent: string | null;
  consent_text: string | null;
}

export interface DocumentPdfInput {
  title: string;
  kind: DocumentKind;
  body_md: string;
  created_at: string;
  sent_at?: string | null;
  expires_at?: string | null;
  completed_at?: string | null;
  status: string;
  reference: string;
}

export interface DocumentBranding {
  brand_name: string;
  support_email?: string | null;
  primary_color?: string | null;
}

export interface DocumentRenderOptions {
  timezone?: string | null;
  business?: string | null;
  redactEvidence?: boolean;
  /** SHA-256 of the unsigned document; printed on every signature block. */
  documentHash?: string | null;
}

const KIND_LABEL: Record<DocumentKind, string> = { contract: "CONTRACT", proposal: "PROPOSAL", nda: "NDA", letter: "LETTER", form: "FORM", other: "DOCUMENT" };

function hexColor(c: string | null | undefined): Rgb | null {
  if (!c || !/^#[0-9a-f]{6}$/i.test(c)) return null;
  return [parseInt(c.slice(1, 3), 16) / 255, parseInt(c.slice(3, 5), 16) / 255, parseInt(c.slice(5, 7), 16) / 255];
}

/** Word-wrap mixed bold/regular runs and draw them; returns nothing, advances the flow. */
function drawRuns(flow: Flow, runs: InlineRun[], size: number, x: number, maxWidth: number, color: Rgb = INK, baseBold = false): void {
  type Word = { text: string; font: PdfFont };
  const words: Word[] = [];
  for (const r of runs) {
    const font: PdfFont = r.bold || baseBold ? "Helvetica-Bold" : "Helvetica";
    for (const w of r.text.split(/\s+/).filter(Boolean)) words.push({ text: w, font });
  }
  const lh = size * 1.4;
  const space = measureText(" ", size);
  let line: Word[] = [];
  let width = 0;
  const emit = () => {
    flow.ensure(lh);
    let cx = x;
    for (const w of line) {
      flow.page.text(cx, flow.y, w.text, { size, font: w.font, color });
      cx += measureText(w.text, size, w.font) + space;
    }
    flow.y += lh;
    line = [];
    width = 0;
  };
  if (words.length === 0) {
    flow.y += lh;
    return;
  }
  for (const w of words) {
    const ww = measureText(w.text, size, w.font);
    if (line.length && width + space + ww > maxWidth) emit();
    width += (line.length ? space : 0) + ww;
    line.push(w);
  }
  if (line.length) emit();
}

function drawBlocks(flow: Flow, blocks: MdBlock[]): void {
  for (const b of blocks) {
    switch (b.type) {
      case "heading": {
        const size = b.level === 1 ? 16 : b.level === 2 ? 13 : 11;
        flow.ensure(size * 2.4);
        flow.gap(b.level === 1 ? 10 : 6);
        drawRuns(flow, b.runs, size, flow.margin, flow.width, INK, true);
        flow.gap(4);
        break;
      }
      case "paragraph":
        drawRuns(flow, b.runs, 10, flow.margin, flow.width);
        flow.gap(6);
        break;
      case "list": {
        const indent = 16;
        b.items.forEach((runs, i) => {
          flow.ensure(14);
          const marker = b.ordered ? `${i + 1}.` : "•";
          flow.page.text(flow.margin + 4, flow.y, marker, { size: 10, color: INK });
          drawRuns(flow, runs, 10, flow.margin + indent + 4, flow.width - indent - 4);
        });
        flow.gap(6);
        break;
      }
      case "table": {
        const cols = Math.max(...b.rows.map((r) => r.length));
        const colW = flow.width / cols;
        b.rows.forEach((row, ri) => {
          flow.ensure(16);
          if (ri === 0) flow.page.rect(flow.margin, flow.y - 10, flow.width, 15, { fill: PANEL });
          for (let c = 0; c < cols; c++) {
            const txt = parseInline(row[c] ?? "")
              .map((r) => r.text)
              .join("");
            flow.page.textBlock(flow.margin + c * colW + 4, flow.y, txt, { size: 9, font: ri === 0 ? "Helvetica-Bold" : "Helvetica", maxWidth: colW - 8, maxLines: 1, color: INK });
          }
          flow.y += 15;
          flow.page.line(flow.margin, flow.y - 10, flow.right, flow.y - 10, { color: RULE, width: 0.3 });
        });
        flow.gap(8);
        break;
      }
      case "rule":
        flow.ensure(12);
        flow.page.line(flow.margin, flow.y - 4, flow.right, flow.y - 4, { color: RULE });
        flow.gap(10);
        break;
    }
  }
}

function drawSignerBlock(flow: Flow, s: SignerStamp, docHash: string | null, tz: string | null | undefined, redact: boolean): void {
  const inner = flow.margin + 12;
  const labelW = 110;
  const valueX = inner + labelW;
  const valueW = flow.width - labelW - 24;
  const rows: Array<[string, string, { font?: PdfFont; size?: number }?]> = [
    // The public (signer) copy never prints the other signers' full addresses.
    ["Signed by", `${s.name} <${redact ? emailHint(s.email) : s.email}>${s.role ? ` (${s.role})` : ""}`],
    ["Signature", s.signature_text?.trim() || s.name, { font: "Helvetica-Oblique", size: 15 }],
    ["Signed at (UTC)", fmtInstant(s.signed_at, "UTC")],
  ];
  if (tz && tz !== "UTC") rows.push([`Signed at (${tz})`, fmtInstant(s.signed_at, tz)]);
  if (redact) rows.push(["Evidence", "IP and device recorded"]);
  else {
    rows.push(["IP address", s.ip || "—"]);
    rows.push(["User agent", s.user_agent || "—"]);
  }
  rows.push(["Consent", s.consent_text || CONSENT_TEXT]);
  if (docHash) rows.push(["Document SHA-256", docHash]);

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
  flow.page.rect(flow.margin, top, flow.width, h, { fill: PANEL, stroke: RULE });
  flow.page.text(inner, y, "ELECTRONICALLY SIGNED", { size: 9, font: "Helvetica-Bold", color: [0.05, 0.45, 0.25] });
  y += 18;
  for (const [label, value, o] of rows) {
    const size = o?.size ?? 9.5;
    flow.page.text(inner, y, label, { size: 8.5, color: MUTED });
    const r = flow.page.textBlock(valueX, y, value, { size, font: o?.font, maxWidth: valueW, lineHeight: size * 1.3, color: INK });
    y = Math.max(y + size * 1.3, r.nextY) + 4;
  }
  flow.y = top + h + 12;
}

/**
 * Render a document. `stamps = null` is the unsigned document whose hash is
 * fingerprinted at signing time; with stamps, a "Signatures" section is
 * appended (one block per signer + the unsigned hash) on a new page.
 */
export function renderDocumentPdf(doc: DocumentPdfInput, stamps: SignerStamp[] | null, branding: DocumentBranding, opts: DocumentRenderOptions = {}): Uint8Array {
  const brand = branding.brand_name?.trim() || opts.business?.trim() || "Document";
  const accent = hexColor(branding.primary_color) ?? [0.97, 0.45, 0.09];
  const pdf = new PdfDocument({ title: doc.title, author: brand, subject: `${doc.title}${stamps ? " (signed)" : ""}` });
  const meta: Array<[string, string]> = [["Date", fmtDateOnly(doc.sent_at ?? doc.created_at)]];
  if (doc.expires_at && !stamps) meta.push(["Sign by", fmtDateOnly(doc.expires_at)]);
  if (stamps && doc.completed_at) meta.push(["Completed", fmtDateOnly(doc.completed_at)]);
  meta.push(["Status", stamps ? "signed" : doc.status]);
  const flow = new Flow(pdf, (p) => drawHeader(p, { brand, kindLabel: KIND_LABEL[doc.kind] ?? "DOCUMENT", number: doc.reference, accent, meta }, 48));

  flow.ensure(30);
  flow.page.text(flow.margin, flow.y + 6, doc.title, { size: 18, font: "Helvetica-Bold", color: INK });
  flow.y += 30;
  drawBlocks(flow, parseMarkdown(doc.body_md));

  if (stamps && stamps.length) {
    flow.page = pdf.addPage();
    flow.y = drawHeader(flow.page, { brand, kindLabel: "SIGNATURES", number: doc.reference, accent, meta }, 48);
    flow.page.text(flow.margin, flow.y + 4, "Signature certificate", { size: 14, font: "Helvetica-Bold", color: INK });
    flow.y += 24;
    for (const s of stamps) drawSignerBlock(flow, s, opts.documentHash ?? null, opts.timezone, opts.redactEvidence === true);
  }

  const footer = [brand, branding.support_email ?? null, stamps && opts.documentHash ? `Signed copy · fingerprint ${opts.documentHash.slice(0, 16)}…` : doc.reference].filter(Boolean).join("  ·  ");
  drawFooters(pdf, footer, 48);
  return pdf.render();
}

export { documentHash };
