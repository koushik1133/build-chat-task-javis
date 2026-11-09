import { describe, expect, it } from "vitest";
import { discardDraft, pendingDraftIndex, releaseDraft } from "@/lib/messaging/reply-turns";
import type { ConversationTurn } from "@/lib/twilio-webhook";

const turns: ConversationTurn[] = [
  { role: "user", content: "Hi", ts: "2026-03-01T10:00:00.000Z" },
  { role: "assistant", content: "Hello!", ts: "2026-03-01T10:00:01.000Z" },
  { role: "user", content: "Discount?", ts: "2026-03-01T10:01:00.000Z" },
  { role: "assistant", content: "Draft: 10% off", ts: "2026-03-01T10:01:01.000Z", pending: true },
];

describe("messaging.reply draft handling", () => {
  it("finds the newest pending assistant turn", () => {
    expect(pendingDraftIndex(turns)).toBe(3);
    expect(pendingDraftIndex(turns.slice(0, 3))).toBe(-1);
  });

  it("approve releases the hidden draft with the (possibly edited) text and a fresh timestamp", () => {
    const now = new Date("2026-03-01T10:05:00.000Z");
    const { turns: out, released } = releaseDraft(turns, "Yes — 10% off this week.", { now });
    expect(released).toBe(true);
    expect(out).toHaveLength(4);
    expect(out[3]).toEqual({ role: "assistant", content: "Yes — 10% off this week.", ts: now.toISOString() });
    expect(out[3].pending).toBeUndefined();
    // input is not mutated
    expect(turns[3].pending).toBe(true);
  });

  it("approve without a draft appends a visible turn; simulated sends are flagged", () => {
    const { turns: out, released } = releaseDraft(turns.slice(0, 3), "Sure", { simulated: true });
    expect(released).toBe(false);
    expect(out).toHaveLength(4);
    expect(out[3]).toMatchObject({ role: "assistant", content: "Sure", simulated: true });
  });

  it("reject removes the draft so it can never surface", () => {
    const { turns: out, discarded } = discardDraft(turns);
    expect(discarded).toBe(true);
    expect(out).toHaveLength(3);
    expect(out.some((t) => t.pending)).toBe(false);
    expect(discardDraft(out).discarded).toBe(false);
  });
});
