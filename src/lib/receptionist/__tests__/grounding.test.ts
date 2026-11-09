import { describe, expect, it } from "vitest";
import { citationSuffix, GROUNDING_THRESHOLD, precheckGrounding } from "../inbound-agent";

const hit = (title: string, score: number) => ({ title, score, slug: title.toLowerCase() });

describe("precheckGrounding", () => {
  it("refuses a factual question with no retrieval and no profile overlap", () => {
    const r = precheckGrounding("What are your prices?", [], null);
    expect(r.refuse).toBe(true);
    expect(r.grounding.refused).toBe(true);
    expect(r.grounding.sources).toEqual([]);
  });
  it("refuses when hits are below threshold", () => {
    expect(precheckGrounding("what are your hours", [hit("Careers", GROUNDING_THRESHOLD - 0.1)], null).refuse).toBe(true);
  });
  it("answers when a hit clears the threshold, with sources and confidence", () => {
    const r = precheckGrounding("what are your hours", [hit("Opening hours", 0.8), hit("Noise", 0.2)], null);
    expect(r.refuse).toBe(false);
    expect(r.grounding.sources.map((s) => s.title)).toEqual(["Opening hours"]);
    expect(r.grounding.confidence).toBe(0.8);
  });
  it("does not refuse non-factual chat", () => {
    expect(precheckGrounding("can someone call me?", [], null).refuse).toBe(false);
  });
  it("uses business profile overlap as grounding", () => {
    const r = precheckGrounding("solar pricing?", [], "We install solar panels");
    expect(r.refuse).toBe(false);
    expect(r.grounding.sources[0].title).toBe("Business profile");
  });
  it("builds a citation suffix", () => {
    expect(citationSuffix([hit("A", 1), hit("A", 1), hit("B", 1)])).toBe(" (Source: A; B)");
    expect(citationSuffix([])).toBe("");
  });
});
