import { describe, expect, it } from "vitest";
import { aggregateScores, clampScore, parseCases, parseJudgeOutput } from "@/lib/evals/score";

describe("parseCases", () => {
  it("accepts JSON text or arrays and drops rows without an input", () => {
    const raw = JSON.stringify([
      { input: "  Plan my day ", expected: "a plan", rubric: "" },
      { input: "", expected: "ignored" },
      "nope",
      { input: "Second", rubric: "be brief" },
    ]);
    expect(parseCases(raw)).toEqual([
      { input: "Plan my day", expected: "a plan", rubric: undefined },
      { input: "Second", expected: undefined, rubric: "be brief" },
    ]);
    expect(parseCases("{bad json")).toEqual([]);
    expect(parseCases(null)).toEqual([]);
  });
});

describe("parseJudgeOutput", () => {
  it("parses clean JSON, fenced JSON and JSON with prose around it", () => {
    expect(parseJudgeOutput('{"score": 85, "reasons": "Solid."}')).toEqual({ score: 85, reasons: "Solid." });
    expect(parseJudgeOutput('```json\n{"score": "72", "reasons": ["a", "b"]}\n```')).toEqual({ score: 72, reasons: "a b" });
    expect(parseJudgeOutput('Sure! Here is my verdict: {"score": 140, "reason": "too high"} thanks')).toEqual({ score: 100, reasons: "too high" });
  });

  it("falls back to a bare score and returns null when nothing parses", () => {
    expect(parseJudgeOutput("Score: 64 — reasonable")).toEqual({ score: 64, reasons: "" });
    expect(parseJudgeOutput("no verdict here")).toBeNull();
    expect(parseJudgeOutput("")).toBeNull();
  });

  it("clamps scores into 0..100", () => {
    expect(clampScore(-5)).toBe(0);
    expect(clampScore(55.6)).toBe(56);
    expect(clampScore("abc")).toBeNull();
  });
});

describe("aggregateScores", () => {
  it("averages judged cases, counts pass/fail at the threshold and excludes errored ones", () => {
    const s = aggregateScores([{ score: 90 }, { score: 70 }, { score: 40 }, { score: null }]);
    expect(s).toEqual({ score: 67, total: 4, judged: 3, passed: 2, failed: 1, errored: 1 });
  });

  it("returns a null score when nothing was judged", () => {
    expect(aggregateScores([])).toEqual({ score: null, total: 0, judged: 0, passed: 0, failed: 0, errored: 0 });
    expect(aggregateScores([{ score: null }]).score).toBeNull();
  });
});
