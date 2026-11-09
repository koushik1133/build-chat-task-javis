import { describe, expect, it } from "vitest";
import { CHECKLIST_KEYS, deriveChecklist, EMPTY_FACTS } from "../checklist";
import { starterAgentsFor, CompleteBody } from "../complete";

describe("onboarding checklist", () => {
  it("starts empty with 0% progress", () => {
    const c = deriveChecklist(EMPTY_FACTS);
    expect(c.total).toBe(CHECKLIST_KEYS.length);
    expect(c.done).toBe(0);
    expect(c.progress).toBe(0);
    expect(c.complete).toBe(false);
    expect(c.items.every((i) => !i.done)).toBe(true);
    expect(c.items.every((i) => i.href.startsWith("/"))).toBe(true);
  });

  it("marks items done from facts and computes progress", () => {
    const c = deriveChecklist({ ...EMPTY_FACTS, profileCompleted: true, packsInstalled: 2, contacts: 1, aiBudgetSet: true });
    const done = Object.fromEntries(c.items.map((i) => [i.key, i.done]));
    expect(done).toMatchObject({ profile: true, pack: true, contact: true, budget: true, quote: false, booking: false, team: false, channel: false });
    expect(c.done).toBe(4);
    expect(c.progress).toBe(50);
  });

  it("is complete when every fact is satisfied", () => {
    const c = deriveChecklist({ profileCompleted: true, packsInstalled: 1, contacts: 3, quotes: 1, activeBookingTypes: 1, teamMembers: 1, channelsConnected: 1, aiBudgetSet: true });
    expect(c.complete).toBe(true);
    expect(c.progress).toBe(100);
  });
});

describe("onboarding completion", () => {
  it("picks three starter agents per industry with a sensible fallback", () => {
    for (const ind of ["healthcare", "agency", "legal", "realestate", "ecommerce", "field-service", "startup", "nonprofit", "education", "hiring", "unknown-thing"]) {
      const agents = starterAgentsFor(ind);
      expect(agents, ind).toHaveLength(3);
      expect(new Set(agents.map((a) => a.id)).size).toBe(3);
    }
    expect(starterAgentsFor("agency").map((a) => a.id)).toContain("content-writer");
  });

  it("validates the complete payload strictly with defaults", () => {
    const ok = CompleteBody.safeParse({ industry: "agency" });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.modules.invoicing).toBe(true);
      expect(ok.data.ai.autonomy).toBe("approve");
      expect(ok.data.packs).toEqual([]);
    }
    expect(CompleteBody.safeParse({ industry: "agency", extra: 1 }).success).toBe(false);
    expect(CompleteBody.safeParse({ industry: "agency", ai: { autonomy: "yolo" } }).success).toBe(false);
  });
});
