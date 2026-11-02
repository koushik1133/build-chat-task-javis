import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const queryOne = vi.fn();
vi.mock("@/lib/dsql", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
}));
const searchChunks = vi.fn();
vi.mock("@/lib/pinecone", () => ({
  searchChunks: (...args: unknown[]) => searchChunks(...args),
  upsertChunks: vi.fn(),
  deleteFile: vi.fn(),
}));

import { correctionText, formatCorrectionsBlock, keywordsFor, recallCorrections } from "@/lib/agents/memory";

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  searchChunks.mockReset();
});

describe("formatCorrectionsBlock", () => {
  it("is empty when there are no corrections", () => {
    expect(formatCorrectionsBlock([])).toBe("");
  });

  it("renders a numbered operator-corrections block with optional reasons", () => {
    const block = formatCorrectionsBlock([
      { original: "Email the client at 6am", corrected: "Email clients only during business hours", note: "They complained" },
      { original: "Use   lots\nof   whitespace", corrected: "Be concise", note: null },
    ]);
    expect(block).toContain("## Past corrections from your operator");
    expect(block).toContain("1. Instead of: Email the client at 6am\n   Do: Email clients only during business hours\n   Why: They complained");
    expect(block).toContain("2. Instead of: Use lots of whitespace\n   Do: Be concise");
    expect(block).not.toContain("Why: \n");
  });

  it("clips very long entries", () => {
    const block = formatCorrectionsBlock([{ original: "x".repeat(2000), corrected: "y", note: null }]);
    expect(block.length).toBeLessThan(900);
    expect(block).toContain("…");
  });

  it("builds the embedded text from both halves", () => {
    expect(correctionText({ original: "a", corrected: "b", note: "c" })).toBe("Instead of: a\nDo: b\nNote: c");
    expect(correctionText({ original: "a", corrected: "b" })).toBe("Instead of: a\nDo: b");
  });
});

describe("keywordsFor", () => {
  it("picks a few distinctive words and skips stop words", () => {
    expect(keywordsFor("Please send the weekly invoice reminder today")).toEqual(["reminder", "invoice", "weekly"]);
    expect(keywordsFor(null)).toEqual([]);
  });
});

describe("recallCorrections", () => {
  const row = (id: string) => ({ id, agent_id: "a1", original_text: `o-${id}`, corrected_text: `c-${id}`, note: null, created_at: "2026-01-01" });

  it("uses Pinecone hits first, keeping their rank", async () => {
    searchChunks.mockResolvedValue([
      { fileId: "corr:two", text: "", fileName: "", score: 0.9 },
      { fileId: "doc-123", text: "", fileName: "", score: 0.8 }, // not a correction
      { fileId: "corr:one", text: "", fileName: "", score: 0.7 },
    ]);
    query.mockImplementation(async (sql: string, params: unknown[]) => {
      expect(sql).toContain("id IN ($3, $4)");
      expect(params.slice(2)).toEqual(["two", "one"]);
      return [row("one"), row("two")];
    });
    const out = await recallCorrections("u1", "a1", 5, "send invoice reminders");
    expect(out.map((c) => c.id)).toEqual(["two", "one"]);
    expect(out[0]).toMatchObject({ original: "o-two", corrected: "c-two" });
  });

  it("falls back to ILIKE on task keywords, then recency, when Pinecone is unavailable", async () => {
    searchChunks.mockRejectedValue(new Error("PINECONE_API_KEY not set"));
    const calls: string[] = [];
    query.mockImplementation(async (sql: string, params: unknown[]) => {
      calls.push(sql);
      if (sql.includes("ILIKE")) {
        expect(params[3]).toBe("%invoice%");
        return [];
      }
      return [row("latest")];
    });
    const out = await recallCorrections("u1", "a1", 3, "send invoice reminders");
    expect(calls.some((s) => s.includes("ILIKE"))).toBe(true);
    expect(out.map((c) => c.id)).toEqual(["latest"]);
  });

  it("returns the most recent corrections when there is no task text", async () => {
    query.mockResolvedValue([row("r1"), row("r2")]);
    const out = await recallCorrections("u1", "a1", 2);
    expect(searchChunks).not.toHaveBeenCalled();
    expect(out).toHaveLength(2);
  });
});
