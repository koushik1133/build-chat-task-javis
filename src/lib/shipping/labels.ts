import { PdfDocument } from "@/lib/pdf/writer";
import { code39Bars } from "./rules";
import { formatAddressLines, type Address } from "./types";

/** 4×6 inch shipping label (dependency-free PDF). Pure: no DB. */

export interface LabelInput {
  carrier: string;
  service: string;
  tracking_number: string;
  from: Address | null;
  to: Address | null;
  weight_grams: number | null;
  order_number: string | null;
  simulated: boolean;
  reference?: string | null;
}

const INK = [0, 0, 0] as const;

export function renderShippingLabelPdf(l: LabelInput): Uint8Array {
  const doc = new PdfDocument({ width: 288, height: 432, title: `Shipping label ${l.tracking_number}`, author: "KernelHub", subject: l.order_number ? `Order ${l.order_number}` : "Shipment" });
  const p = doc.addPage();
  const W = 288;
  p.rect(10, 10, W - 20, 412, { stroke: INK, width: 1.5 });
  // Carrier banner
  p.rect(10, 10, W - 20, 34, { fill: INK });
  p.text(20, 33, l.carrier.toUpperCase().slice(0, 18), { size: 16, font: "Helvetica-Bold", color: [1, 1, 1] });
  p.text(W - 20, 33, l.service.toUpperCase().slice(0, 18), { size: 12, font: "Helvetica-Bold", color: [1, 1, 1], align: "right" });
  // From
  p.text(20, 60, "FROM", { size: 7, font: "Helvetica-Bold" });
  let y = 71;
  for (const line of formatAddressLines(l.from).slice(0, 5)) {
    p.text(20, y, line.slice(0, 44), { size: 8 });
    y += 10;
  }
  p.line(10, 118, W - 10, 118, { width: 1 });
  // To
  p.text(20, 134, "SHIP TO", { size: 8, font: "Helvetica-Bold" });
  y = 152;
  const toLines = formatAddressLines(l.to).slice(0, 6);
  toLines.forEach((line, i) => {
    p.text(20, y, line.slice(0, 32), { size: i === 0 ? 15 : 12, font: i === 0 ? "Helvetica-Bold" : "Helvetica" });
    y += i === 0 ? 20 : 16;
  });
  p.line(10, 262, W - 10, 262, { width: 1 });
  // Meta
  p.text(20, 278, `WT ${l.weight_grams ? (l.weight_grams / 1000).toFixed(2) : "-"} kg`, { size: 9, font: "Helvetica-Bold" });
  if (l.order_number) p.text(W - 20, 278, `ORDER ${l.order_number}`, { size: 9, font: "Helvetica-Bold", align: "right" });
  // Barcode (Code 39) scaled to fit
  const { bars, width } = code39Bars(l.tracking_number);
  const maxW = W - 60;
  const unit = Math.min(2, maxW / width);
  const x0 = (W - width * unit) / 2;
  for (const b of bars) p.rect(x0 + b.x * unit, 296, b.w * unit, 72, { fill: INK });
  p.text(W / 2, 384, l.tracking_number, { size: 12, font: "Helvetica-Bold", align: "center" });
  if (l.simulated) {
    p.text(W / 2, 404, "SIMULATED LABEL - NOT VALID FOR POSTAGE", { size: 7, font: "Helvetica-Bold", align: "center" });
  } else if (l.reference) {
    p.text(W / 2, 404, l.reference.slice(0, 60), { size: 7, align: "center" });
  }
  return doc.render();
}
