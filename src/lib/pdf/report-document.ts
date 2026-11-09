import { PdfDocument, measureText } from "./writer";
import { Flow, INK, MUTED, PANEL, RULE, drawFooters, drawHeader, fmtDateOnly, type DocBranding, type RenderOptions } from "./quote-document";

/**
 * Generic tabular report PDF (saved reports export + scheduled PDF delivery).
 * Pure renderer: columns + already-formatted cell strings in, bytes out.
 */

export interface TablePdfInput {
  title: string;
  subtitle?: string | null;
  columns: Array<{ key: string; label: string; align?: "left" | "right" }>;
  rows: Array<Record<string, string>>;
  totals?: Record<string, string> | null;
  generated_at: string;
  /** Rows beyond this are summarised in a footer line. */
  maxRows?: number;
}

function hexColor(c: string | null | undefined): readonly [number, number, number] | null {
  if (!c || !/^#[0-9a-f]{6}$/i.test(c)) return null;
  return [parseInt(c.slice(1, 3), 16) / 255, parseInt(c.slice(3, 5), 16) / 255, parseInt(c.slice(5, 7), 16) / 255];
}

function clip(text: string, width: number, size: number): string {
  if (measureText(text, size) <= width) return text;
  let t = text;
  while (t.length > 1 && measureText(`${t}…`, size) > width) t = t.slice(0, -1);
  return `${t}…`;
}

export function renderTablePdf(input: TablePdfInput, branding: DocBranding, opts: RenderOptions = {}): Uint8Array {
  const brand = branding.brand_name?.trim() || opts.business?.trim() || "Report";
  const accent = hexColor(branding.primary_color) ?? [0.16, 0.47, 0.84];
  const doc = new PdfDocument({ title: input.title, author: brand, subject: input.title });
  const meta: Array<[string, string]> = [["Generated", fmtDateOnly(input.generated_at)], ["Rows", String(input.rows.length)]];
  const flow = new Flow(doc, (p) => drawHeader(p, { brand, kindLabel: "REPORT", number: clip(input.title, 220, 11), accent, meta }, 48));

  if (input.subtitle) {
    flow.page.text(flow.margin, flow.y + 2, clip(input.subtitle, flow.width, 9), { size: 9, color: MUTED });
    flow.y += 18;
  }

  const cols = input.columns.slice(0, 10);
  if (cols.length === 0) return doc.render();
  const size = cols.length > 6 ? 7.5 : 9;
  // First column gets the leftover width; the rest share evenly (min 60pt).
  const fixed = Math.max(60, Math.min(110, Math.floor((flow.width * 0.6) / Math.max(1, cols.length - 1))));
  const firstW = flow.width - fixed * (cols.length - 1);
  const xs: number[] = [];
  let x = flow.margin;
  for (let i = 0; i < cols.length; i++) {
    xs.push(x);
    x += i === 0 ? firstW : fixed;
  }
  const widthOf = (i: number) => (i === 0 ? firstW : fixed) - 8;
  const align = (i: number) => cols[i].align ?? (i === 0 ? "left" : "right");
  const cellX = (i: number) => (align(i) === "right" ? xs[i] + widthOf(i) + 4 : xs[i] + 4);

  const header = () => {
    flow.ensure(24);
    flow.page.rect(flow.margin, flow.y - 11, flow.width, 18, { fill: PANEL });
    cols.forEach((c, i) => flow.page.text(cellX(i), flow.y + 1, clip(c.label.toUpperCase(), widthOf(i), 7.5), { size: 7.5, font: "Helvetica-Bold", color: MUTED, align: align(i) }));
    flow.y += 18;
  };
  header();

  const max = Math.max(1, Math.min(input.maxRows ?? 2000, input.rows.length));
  const rows = input.rows.slice(0, max);
  if (rows.length === 0) {
    flow.page.text(flow.margin + 4, flow.y + 4, "No rows for this period", { size: 9, color: MUTED });
    flow.y += 18;
  }
  for (const r of rows) {
    const before = flow.y;
    flow.ensure(16);
    if (flow.y !== before) header();
    cols.forEach((c, i) => flow.page.text(cellX(i), flow.y + 3, clip(r[c.key] ?? "", widthOf(i), size), { size, color: INK, align: align(i) }));
    flow.y += 15;
    flow.page.line(flow.margin, flow.y - 3, flow.right, flow.y - 3, { color: RULE });
  }
  if (input.rows.length > rows.length) {
    flow.ensure(16);
    flow.page.text(flow.margin + 4, flow.y + 4, `… ${input.rows.length - rows.length} more rows (download the CSV for the full set)`, { size: 8, color: MUTED });
    flow.y += 16;
  }
  if (input.totals) {
    flow.ensure(20);
    flow.page.rect(flow.margin, flow.y - 10, flow.width, 18, { fill: PANEL });
    cols.forEach((c, i) => {
      const v = i === 0 ? "Total" : (input.totals?.[c.key] ?? "");
      flow.page.text(cellX(i), flow.y + 2, clip(v, widthOf(i), size), { size, font: "Helvetica-Bold", color: INK, align: align(i) });
    });
    flow.y += 20;
  }
  drawFooters(doc, `${brand} · ${input.title}`, 48);
  return doc.render();
}
