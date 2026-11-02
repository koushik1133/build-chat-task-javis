import type { ImportField, ImportTarget } from "./targets";

/**
 * Column mapping: CSV header → target field.
 *
 * `heuristicMapping` is pure and synchronous (name similarity + value
 * sniffing). `suggestMapping` runs it first and, when an LLM is configured,
 * asks the model to refine ambiguous columns. The model can only choose from
 * the real headers and fields, so a hallucinated answer is dropped.
 */

export type Mapping = Record<string, string | null>; // fieldKey → header

export interface MappingSuggestion {
  mapping: Mapping;
  confidence: Record<string, number>;
  unmappedHeaders: string[];
  source: "heuristic" | "ai";
}

export function normaliseHeader(h: string): string {
  return h
    .replace(/^﻿/, "")
    .toLowerCase()
    .replace(/[_\-./]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[\d\s().-]{7,}$/;
const MONEY_RE = /^\(?-?[$€£¥₹]?\s?-?\d{1,3}(?:[,.\s]?\d{3})*(?:[.,]\d{1,2})?\)?$/;
const NUMBER_RE = /^-?\d+(?:[.,]\d+)?$/;
const BOOL_SET = new Set(["true", "false", "yes", "no", "y", "n", "1", "0", "done", "open", "x", "complete", "completed", "incomplete"]);
const DATE_RE = /^(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})(?:[ T].*)?$/;

/** 0..1 fraction of non-empty sample values that look like `type`. */
export function sniffType(values: string[], type: ImportField["type"], field?: ImportField): number {
  const vals = values.map((v) => (v ?? "").trim()).filter(Boolean);
  if (vals.length === 0) return 0;
  let hits = 0;
  for (const v of vals) {
    const lower = v.toLowerCase();
    switch (type) {
      case "email":
        if (EMAIL_RE.test(v)) hits++;
        break;
      case "phone":
        if (PHONE_RE.test(v) && v.replace(/\D/g, "").length >= 7) hits++;
        break;
      case "money":
        if (MONEY_RE.test(v.replace(/\s/g, ""))) hits++;
        break;
      case "number":
        if (NUMBER_RE.test(v.replace(/,/g, ""))) hits++;
        break;
      case "boolean":
        if (BOOL_SET.has(lower)) hits++;
        break;
      case "date":
      case "datetime":
        if (DATE_RE.test(v) || (/[a-z]{3}/i.test(v) && !Number.isNaN(Date.parse(v)))) hits++;
        break;
      case "enum":
        if (field?.values?.some((o) => o.toLowerCase() === lower)) hits++;
        break;
      case "tags":
        if (/[,;|]/.test(v) || /^[a-z0-9 _-]+$/i.test(v)) hits++;
        break;
      default:
        hits++;
    }
  }
  return hits / vals.length;
}

function nameScore(header: string, field: ImportField): number {
  const h = normaliseHeader(header);
  if (!h) return 0;
  const key = normaliseHeader(field.key);
  const label = normaliseHeader(field.label);
  if (h === key || h === label) return 1;
  const syns = field.synonyms.map(normaliseHeader);
  if (syns.includes(h)) return 0.92;
  const hTokens = new Set(h.split(" "));
  let best = 0;
  for (const cand of [key, label, ...syns]) {
    const cTokens = cand.split(" ").filter(Boolean);
    if (cTokens.length === 0) continue;
    const overlap = cTokens.filter((t) => hTokens.has(t)).length;
    if (overlap === 0) continue;
    // Partial credit: fraction of candidate tokens present, penalised by extra header tokens.
    const frac = overlap / cTokens.length;
    const extra = Math.max(0, hTokens.size - overlap);
    best = Math.max(best, frac * 0.75 - extra * 0.08);
  }
  // Substring match ("customer_email" ~ "email").
  if (best < 0.5) {
    for (const cand of [key, label, ...syns]) {
      if (cand.length >= 4 && (h.includes(cand) || cand.includes(h))) best = Math.max(best, 0.55);
    }
  }
  return Math.max(0, best);
}

/** Money needs a currency symbol, thousands separator or 2 decimals; numbers need decimals. */
function strongNumeric(values: string[], type: "money" | "number"): boolean {
  const vals = values.map((v) => v.trim()).filter(Boolean);
  if (vals.length === 0) return false;
  const re = type === "money" ? /[$€£¥₹]|\d[.,]\d{2}$|\d,\d{3}/ : /\d[.,]\d/;
  return vals.filter((v) => re.test(v)).length / vals.length >= 0.8;
}

const TYPED: ReadonlySet<ImportField["type"]> = new Set(["email", "phone", "money", "number", "boolean", "date", "datetime", "enum"]);

export function heuristicMapping(headers: string[], sampleRows: string[][], target: ImportTarget): MappingSuggestion {
  const columns = headers.map((h, i) => ({ header: h, values: sampleRows.map((r) => r[i] ?? "") }));
  const pairs: Array<{ field: string; header: string; score: number }> = [];

  for (const field of target.fields) {
    for (const col of columns) {
      const name = nameScore(col.header, field);
      const typed = TYPED.has(field.type);
      const sniff = typed ? sniffType(col.values, field.type, field) : 0;
      let score = name;
      if (typed) {
        if (sniff >= 0.8) {
          // Sniffing alone is only decisive for distinctive shapes; a bare
          // number column could be anything, so money/number need a strong signal.
          const strong = field.type === "money" || field.type === "number" ? strongNumeric(col.values, field.type) : true;
          score += name > 0 ? (strong ? 0.25 : 0.1) : strong ? 0.5 : 0.2;
        } else if (sniff < 0.3 && col.values.some((v) => v.trim())) {
          score = name * 0.3; // values contradict the type: header name alone is not enough
        }
      }
      // A "status" header may mean lifecycle, done, etc. — let value sniffing decide for enums.
      if (field.type === "enum" && sniff >= 0.8 && name > 0) score = Math.max(score, 0.9);
      if (score >= 0.45) pairs.push({ field: field.key, header: col.header, score: Math.min(1, score) });
    }
  }

  pairs.sort((a, b) => b.score - a.score);
  const mapping: Mapping = {};
  const confidence: Record<string, number> = {};
  const usedHeaders = new Set<string>();
  for (const f of target.fields) mapping[f.key] = null;
  for (const p of pairs) {
    if (mapping[p.field] !== null || usedHeaders.has(p.header)) continue;
    mapping[p.field] = p.header;
    confidence[p.field] = Math.round(p.score * 100) / 100;
    usedHeaders.add(p.header);
  }
  return {
    mapping,
    confidence,
    unmappedHeaders: headers.filter((h) => !usedHeaders.has(h)),
    source: "heuristic",
  };
}

interface AiReply {
  mapping?: Record<string, unknown>;
}

/**
 * Heuristic first; LLM refinement when configured (and not disabled). The
 * model answer is validated against real headers/fields and never trusted
 * for required fields the heuristic mapped with high confidence.
 */
export async function suggestMapping(
  headers: string[],
  sampleRows: string[][],
  target: ImportTarget,
  opts: { useAi?: boolean } = {}
): Promise<MappingSuggestion> {
  const base = heuristicMapping(headers, sampleRows, target);
  if (opts.useAi === false) return base;

  let configured = false;
  try {
    const { isLlmConfigured } = await import("@/lib/llm");
    configured = isLlmConfigured();
  } catch {
    configured = false;
  }
  if (!configured) return base;

  // Only bother the model when something is still unmapped or shaky.
  const shaky = target.fields.filter((f) => base.mapping[f.key] === null || (base.confidence[f.key] ?? 0) < 0.8);
  if (shaky.length === 0 || headers.length === 0) return base;

  try {
    const { complete } = await import("@/lib/llm");
    const { parseModelJson } = await import("@/lib/model-json");
    const samples = sampleRows.slice(0, 3).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").slice(0, 60)])));
    const prompt = [
      `You map CSV columns onto fields of the "${target.label}" table.`,
      `Fields (key: type — meaning):`,
      ...target.fields.map((f) => `- ${f.key}: ${f.type}${f.values ? ` one of ${f.values.join("/")}` : ""} — ${f.description ?? f.label}${f.required ? " (required)" : ""}`),
      `CSV headers: ${JSON.stringify(headers)}`,
      `Sample rows: ${JSON.stringify(samples)}`,
      `Current best guess: ${JSON.stringify(base.mapping)}`,
      `Reply with ONLY JSON: {"mapping": {"<fieldKey>": "<exact header>" | null, ...}}. Use each header at most once. Omit fields you are unsure about.`,
    ].join("\n");
    const raw = await complete([{ role: "user", content: prompt }], { retries: 0, maxTokens: 600 });
    const reply = parseModelJson<AiReply>(raw);
    if (!reply || typeof reply.mapping !== "object" || reply.mapping === null) return base;

    const headerSet = new Set(headers);
    const fieldKeys = new Set(target.fields.map((f) => f.key));
    const mapping: Mapping = { ...base.mapping };
    const confidence = { ...base.confidence };
    const used = new Set(Object.values(mapping).filter((v): v is string => Boolean(v)));
    let changed = false;
    for (const [field, header] of Object.entries(reply.mapping)) {
      if (!fieldKeys.has(field)) continue;
      if (header !== null && typeof header !== "string") continue;
      // Keep confident heuristic picks.
      if (mapping[field] && (confidence[field] ?? 0) >= 0.8) continue;
      if (header === null) {
        if (mapping[field]) {
          used.delete(mapping[field] as string);
          mapping[field] = null;
          delete confidence[field];
          changed = true;
        }
        continue;
      }
      if (!headerSet.has(header) || (used.has(header) && mapping[field] !== header)) continue;
      if (mapping[field]) used.delete(mapping[field] as string);
      mapping[field] = header;
      confidence[field] = 0.85;
      used.add(header);
      changed = true;
    }
    if (!changed) return base;
    return { mapping, confidence, unmappedHeaders: headers.filter((h) => !used.has(h)), source: "ai" };
  } catch (err) {
    console.warn("[import] AI mapping refinement failed, using heuristic:", err instanceof Error ? err.message : err);
    return base;
  }
}
