import type { MergeField } from "./types";

/** Client-safe pure half of document rendering (merge fields + markdown subset). No PDF/crypto imports so client bundles stay small. */

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

