/**
 * Pure eval helpers (client-safe): case parsing, judge-output parsing and
 * score aggregation. Everything that touches the DB or a model lives in
 * ./run.ts and ./judge.ts.
 */

export interface EvalCase {
  input: string;
  expected?: string;
  rubric?: string;
}

export type TranscriptKind = "llm" | "tool" | "would_call" | "note";

export interface TranscriptEntry {
  kind: TranscriptKind;
  name: string;
  input?: string | null;
  output?: string | null;
  ms?: number | null;
}

export interface CaseResult {
  idx: number;
  input: string;
  expected: string | null;
  rubric: string | null;
  output: string;
  /** 0–100, or null when the judge failed. */
  score: number | null;
  reasons: string;
  transcript: TranscriptEntry[];
  cost_micros: number;
  turns: number;
  error?: string | null;
}

export const MAX_CASES = 25;

/** Accept the JSON column or an already-parsed array; drop malformed rows. */
export function parseCases(raw: unknown): EvalCase[] {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const out: EvalCase[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const input = typeof o.input === "string" ? o.input.trim() : "";
    if (!input) continue;
    out.push({
      input: input.slice(0, 8000),
      expected: typeof o.expected === "string" && o.expected.trim() ? o.expected.trim().slice(0, 8000) : undefined,
      rubric: typeof o.rubric === "string" && o.rubric.trim() ? o.rubric.trim().slice(0, 4000) : undefined,
    });
    if (out.length >= MAX_CASES) break;
  }
  return out;
}

export interface JudgeVerdict {
  score: number;
  reasons: string;
}

/** Clamp to an integer in 0..100. */
export function clampScore(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Parse `{ "score": 0-100, "reasons": "…" }` from a judge model, tolerating fences and prose. */
export function parseJudgeOutput(raw: string | null | undefined): JudgeVerdict | null {
  if (!raw) return null;
  const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
  const candidates = [cleaned];
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(cleaned.slice(start, end + 1));
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as Record<string, unknown>;
      const score = clampScore(parsed.score);
      if (score === null) continue;
      const reasons =
        typeof parsed.reasons === "string"
          ? parsed.reasons
          : Array.isArray(parsed.reasons)
            ? parsed.reasons.map(String).join(" ")
            : typeof parsed.reason === "string"
              ? parsed.reason
              : "";
      return { score, reasons: reasons.trim().slice(0, 2000) };
    } catch {
      /* try next candidate */
    }
  }
  // Last resort: a bare number somewhere in the text ("Score: 85").
  const m = cleaned.match(/(?:score\s*[:=]?\s*)(\d{1,3})/i) ?? cleaned.match(/^\s*(\d{1,3})\s*$/);
  if (m) {
    const score = clampScore(m[1]);
    if (score !== null) return { score, reasons: "" };
  }
  return null;
}

export interface ScoreSummary {
  /** Mean of judged cases (integer), or null when nothing was judged. */
  score: number | null;
  total: number;
  judged: number;
  passed: number;
  failed: number;
  errored: number;
}

export const PASS_THRESHOLD = 70;

/** Aggregate per-case scores. Cases without a score count as errored and are excluded from the mean. */
export function aggregateScores(results: ReadonlyArray<Pick<CaseResult, "score">>, threshold = PASS_THRESHOLD): ScoreSummary {
  const judged = results.filter((r): r is { score: number } => typeof r.score === "number" && Number.isFinite(r.score));
  const sum = judged.reduce((a, r) => a + r.score, 0);
  return {
    score: judged.length > 0 ? Math.round(sum / judged.length) : null,
    total: results.length,
    judged: judged.length,
    passed: judged.filter((r) => r.score >= threshold).length,
    failed: judged.filter((r) => r.score < threshold).length,
    errored: results.length - judged.length,
  };
}

export function parseResults(raw: unknown): CaseResult[] {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? (value as CaseResult[]) : [];
}
