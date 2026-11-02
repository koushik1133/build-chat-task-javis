/**
 * Minimal dependency-free PDF 1.4 writer.
 *
 * Supports: multiple pages, text in the standard Helvetica family (regular,
 * bold, oblique — no embedding needed), straight lines, rectangles, RGB
 * colours and word-wrapping based on the real Helvetica AFM widths.
 *
 * Coordinates handed to the page API are *top-down* (y = 0 is the top edge)
 * so layout code reads naturally; they are flipped when the content stream is
 * emitted. Output is deterministic for identical input — no timestamps or
 * random ids are written — so document bytes can be fingerprinted.
 */

export type PdfFont = "Helvetica" | "Helvetica-Bold" | "Helvetica-Oblique";
export type Rgb = readonly [number, number, number];

export interface TextOptions {
  size?: number;
  font?: PdfFont;
  color?: Rgb;
  align?: "left" | "right" | "center";
}

export interface WrapOptions extends TextOptions {
  maxWidth: number;
  /** Baseline-to-baseline distance; defaults to 1.3 × size. */
  lineHeight?: number;
  /** Stop after this many lines (the last one is ellipsised). */
  maxLines?: number;
}

export interface LineOptions {
  width?: number;
  color?: Rgb;
}

export interface RectOptions {
  fill?: Rgb;
  stroke?: Rgb;
  width?: number;
}

export interface PdfDocumentOptions {
  width?: number;
  height?: number;
  title?: string;
  author?: string;
  subject?: string;
  producer?: string;
}

/* ─── Font metrics (Adobe AFM widths, 1/1000 em, codes 32..126) ──────────── */

// prettier-ignore
const HELVETICA: number[] = [
  278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,
  1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,
  667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,
  333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,
  556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,
];
// prettier-ignore
const HELVETICA_BOLD: number[] = [
  278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,
  975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,
  667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,
  333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,
  611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,
];

const FONT_IDS: Record<PdfFont, number> = { Helvetica: 1, "Helvetica-Bold": 2, "Helvetica-Oblique": 3 };

function widthTable(font: PdfFont): number[] {
  return font === "Helvetica-Bold" ? HELVETICA_BOLD : HELVETICA;
}

/** Width of `text` in points at `size` using the AFM widths (unknown glyphs ≈ 556). */
export function measureText(text: string, size: number, font: PdfFont = "Helvetica"): number {
  const table = widthTable(font);
  let w = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 32;
    w += code >= 32 && code <= 126 ? table[code - 32] : 556;
  }
  return (w * size) / 1000;
}

/** Greedy word-wrap; very long words are broken by character so nothing overflows. */
export function wrapLines(text: string, maxWidth: number, size: number, font: PdfFont = "Helvetica"): string[] {
  const out: string[] = [];
  for (const para of String(text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (measureText(candidate, size, font) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) out.push(line);
      line = "";
      if (measureText(word, size, font) <= maxWidth) {
        line = word;
        continue;
      }
      // Break an over-long token character by character.
      let chunk = "";
      for (const ch of word) {
        if (measureText(chunk + ch, size, font) > maxWidth && chunk) {
          out.push(chunk);
          chunk = "";
        }
        chunk += ch;
      }
      line = chunk;
    }
    out.push(line);
  }
  return out;
}

/* ─── String encoding (WinAnsi) ──────────────────────────────────────────── */

const CP1252: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** Encode to a PDF literal string body (WinAnsi bytes, escaped). Unmappable glyphs become '?'. */
export function encodePdfString(text: string): string {
  let out = "";
  for (const ch of String(text ?? "")) {
    const cp = ch.codePointAt(0) ?? 63;
    let byte: number;
    if (cp === 0x0a || cp === 0x0d || cp === 0x09) byte = 0x20;
    else if (cp < 0x20) byte = 0x3f;
    else if (cp <= 0xff) byte = cp;
    else byte = CP1252[cp] ?? 0x3f;
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += "\\" + String.fromCharCode(byte);
    else out += String.fromCharCode(byte);
  }
  return out;
}

function num(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function rgb(c: Rgb): string {
  return `${num(c[0])} ${num(c[1])} ${num(c[2])}`;
}

/* ─── Pages ──────────────────────────────────────────────────────────────── */

export class PdfPage {
  private readonly ops: string[] = [];
  constructor(
    public readonly width: number,
    public readonly height: number
  ) {}

  /** Draw a single line of text with its baseline at `y` (top-down). */
  text(x: number, y: number, text: string, opts: TextOptions = {}): void {
    const size = opts.size ?? 10;
    const font = opts.font ?? "Helvetica";
    let tx = x;
    if (opts.align === "right") tx = x - measureText(text, size, font);
    else if (opts.align === "center") tx = x - measureText(text, size, font) / 2;
    const color = opts.color ?? [0, 0, 0];
    this.ops.push(
      `BT /F${FONT_IDS[font]} ${num(size)} Tf ${rgb(color)} rg ${num(tx)} ${num(this.height - y)} Td (${encodePdfString(text)}) Tj ET`
    );
  }

  /** Word-wrap and draw; returns the y of the next free baseline. */
  textBlock(x: number, y: number, text: string, opts: WrapOptions): { nextY: number; lines: number } {
    const size = opts.size ?? 10;
    const font = opts.font ?? "Helvetica";
    const lh = opts.lineHeight ?? size * 1.3;
    let lines = wrapLines(text, opts.maxWidth, size, font);
    if (opts.maxLines && lines.length > opts.maxLines) {
      lines = lines.slice(0, opts.maxLines);
      lines[lines.length - 1] = lines[lines.length - 1].replace(/.{0,2}$/, "…");
    }
    let cy = y;
    for (const line of lines) {
      this.text(x, cy, line, { size, font, color: opts.color, align: opts.align });
      cy += lh;
    }
    return { nextY: cy, lines: lines.length };
  }

  line(x1: number, y1: number, x2: number, y2: number, opts: LineOptions = {}): void {
    const color = opts.color ?? [0, 0, 0];
    this.ops.push(
      `q ${num(opts.width ?? 0.5)} w ${rgb(color)} RG ${num(x1)} ${num(this.height - y1)} m ${num(x2)} ${num(this.height - y2)} l S Q`
    );
  }

  /** Rectangle with its top-left corner at (x, y). */
  rect(x: number, y: number, w: number, h: number, opts: RectOptions = {}): void {
    if (!opts.fill && !opts.stroke) return;
    const parts: string[] = ["q"];
    if (opts.fill) parts.push(`${rgb(opts.fill)} rg`);
    if (opts.stroke) parts.push(`${num(opts.width ?? 0.5)} w ${rgb(opts.stroke)} RG`);
    parts.push(`${num(x)} ${num(this.height - y - h)} ${num(w)} ${num(h)} re`);
    parts.push(opts.fill && opts.stroke ? "B" : opts.fill ? "f" : "S");
    parts.push("Q");
    this.ops.push(parts.join(" "));
  }

  /** @internal */
  contentStream(): string {
    return this.ops.join("\n");
  }
}

/* ─── Document ───────────────────────────────────────────────────────────── */

export class PdfDocument {
  readonly width: number;
  readonly height: number;
  private readonly pages: PdfPage[] = [];
  private readonly info: Required<Pick<PdfDocumentOptions, "title" | "author" | "subject" | "producer">>;

  constructor(opts: PdfDocumentOptions = {}) {
    this.width = opts.width ?? 612; // US Letter
    this.height = opts.height ?? 792;
    this.info = {
      title: opts.title ?? "",
      author: opts.author ?? "",
      subject: opts.subject ?? "",
      producer: opts.producer ?? "KernelHub PDF",
    };
  }

  addPage(): PdfPage {
    const p = new PdfPage(this.width, this.height);
    this.pages.push(p);
    return p;
  }

  get pageCount(): number {
    return this.pages.length;
  }

  getPages(): readonly PdfPage[] {
    return this.pages;
  }

  /** Serialise to bytes. Object numbering: 1 catalog, 2 pages, 3-5 fonts, 6 info, then page/content pairs. */
  render(): Uint8Array {
    if (this.pages.length === 0) this.addPage();
    const objects: string[] = [];
    const firstPageObj = 7;
    const kids = this.pages.map((_, i) => `${firstPageObj + i * 2} 0 R`).join(" ");

    objects.push(`<< /Type /Catalog /Pages 2 0 R >>`);
    objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${this.pages.length} >>`);
    objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`);
    objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`);
    objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>`);
    objects.push(
      `<< /Producer (${encodePdfString(this.info.producer)})` +
        (this.info.title ? ` /Title (${encodePdfString(this.info.title)})` : "") +
        (this.info.author ? ` /Author (${encodePdfString(this.info.author)})` : "") +
        (this.info.subject ? ` /Subject (${encodePdfString(this.info.subject)})` : "") +
        ` >>`
    );

    for (let i = 0; i < this.pages.length; i++) {
      const page = this.pages[i];
      const contentObj = firstPageObj + i * 2 + 1;
      objects.push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(this.width)} ${num(this.height)}] ` +
          `/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${contentObj} 0 R >>`
      );
      const stream = page.contentStream();
      objects.push(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
    }

    const chunks: Buffer[] = [];
    let offset = 0;
    const push = (s: string) => {
      const b = Buffer.from(s, "latin1");
      chunks.push(b);
      offset += b.length;
    };

    push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
    const offsets: number[] = [];
    objects.forEach((body, i) => {
      offsets.push(offset);
      push(`${i + 1} 0 obj\n${body}\nendobj\n`);
    });

    const xrefOffset = offset;
    let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) xref += `${String(o).padStart(10, "0")} 00000 n \n`;
    push(xref);
    push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

    return new Uint8Array(Buffer.concat(chunks));
  }
}
