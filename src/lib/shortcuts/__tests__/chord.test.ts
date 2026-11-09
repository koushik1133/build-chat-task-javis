import { describe, expect, it } from "vitest";
import { CHORD_WINDOW_MS, resolveKey, shouldIgnore } from "../chord";

describe("resolveKey", () => {
  it("g then c navigates to CRM", () => {
    const a = resolveKey(null, "g", 1000);
    expect(a.pending).toEqual({ prefix: "g", at: 1000 });
    expect(resolveKey(a.pending, "c", 1500).action).toEqual({ type: "go", href: "/crm" });
  });
  it("n then q opens the new-quote link", () => {
    const a = resolveKey(null, "n", 0);
    expect(resolveKey(a.pending, "q", 100).action).toEqual({ type: "go", href: "/billing?new=quote" });
  });
  it("expires after the chord window", () => {
    const a = resolveKey(null, "g", 0);
    expect(resolveKey(a.pending, "c", CHORD_WINDOW_MS + 1).action).toBeNull();
    expect(resolveKey(a.pending, "c", CHORD_WINDOW_MS).action).not.toBeNull();
  });
  it("unknown second key cancels and ? still works", () => {
    const a = resolveKey(null, "g", 0);
    expect(resolveKey(a.pending, "z", 10)).toEqual({ pending: null, action: null });
    expect(resolveKey(a.pending, "?", 10).action).toEqual({ type: "help" });
    expect(resolveKey(null, "/", 0).action).toEqual({ type: "focus-search" });
  });
  it("g g restarts the chord", () => {
    const a = resolveKey(null, "g", 0);
    expect(resolveKey(a.pending, "g", 50).pending).toEqual({ prefix: "g", at: 50 });
  });
  it("is case-insensitive for letters", () => {
    const a = resolveKey(null, "G", 0);
    expect(resolveKey(a.pending, "T", 5).action).toEqual({ type: "go", href: "/tasks" });
  });
});

describe("shouldIgnore", () => {
  const e = { metaKey: false, ctrlKey: false, altKey: false };
  it("ignores typing, modifiers and open dialogs", () => {
    expect(shouldIgnore(e, { tagName: "INPUT" }, false)).toBe(true);
    expect(shouldIgnore(e, { tagName: "DIV", isContentEditable: true }, false)).toBe(true);
    expect(shouldIgnore({ ...e, ctrlKey: true }, { tagName: "DIV" }, false)).toBe(true);
    expect(shouldIgnore(e, { tagName: "DIV" }, true)).toBe(true);
    expect(shouldIgnore(e, { tagName: "BODY" }, false)).toBe(false);
  });
});
