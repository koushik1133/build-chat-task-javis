import { describe, expect, it } from "vitest";
import { findForbiddenKey, PORTAL_MESSAGE_MAX, toPortalProject, validateMessageBody, withinChangeWindow } from "@/lib/portal-rules";

describe("portal message validation", () => {
  it("accepts plain text and trims", () => {
    expect(validateMessageBody("  hello  ")).toEqual({ ok: true, body: "hello" });
  });
  it("rejects empty, non-string and over-length", () => {
    expect(validateMessageBody("   ").ok).toBe(false);
    expect(validateMessageBody(42).ok).toBe(false);
    expect(validateMessageBody("x".repeat(PORTAL_MESSAGE_MAX)).ok).toBe(true);
    expect(validateMessageBody("x".repeat(PORTAL_MESSAGE_MAX + 1)).ok).toBe(false);
  });
  it("strips control characters but keeps newlines", () => {
    const r = validateMessageBody("a\u0000b\nc\u0007");
    expect(r).toEqual({ ok: true, body: "ab\nc" });
  });
});

describe("booking change window", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  it("blocks changes inside the window and allows outside it", () => {
    expect(withinChangeWindow("2026-01-01T10:00:00Z", 24, now)).toBe(false);
    expect(withinChangeWindow("2026-01-02T00:00:00Z", 24, now)).toBe(true);
    expect(withinChangeWindow("2026-01-01T01:00:00Z", 0, now)).toBe(true);
  });
});

describe("portal DTOs", () => {
  it("project mapper never carries budget or internal fields", () => {
    const project = { id: "p1", name: "Site", status: "active", due_on: "2026-03-01", budget_minor: 900000, hourly_rate_minor: 100, owner_member_id: "u", description_md: "secret", billing_mode: "fixed" };
    const dto = toPortalProject(project, { percent: 40.4, next_milestone: { name: "Launch", due_on: "2026-02-01" } }, [{ name: "Design", due_on: null, status: "done" }]);
    expect(dto).toEqual({ id: "p1", name: "Site", status: "active", percent: 40, dueOn: "2026-03-01", nextMilestone: { name: "Launch", dueOn: "2026-02-01" }, milestones: [{ name: "Design", dueOn: null, done: true }] });
    expect(findForbiddenKey(dto)).toBeNull();
  });
  it("findForbiddenKey catches nested leaks", () => {
    expect(findForbiddenKey({ a: [{ b: { budget_minor: 1 } }] })).toBe("budget_minor");
    expect(findForbiddenKey({ notes: "x" })).toBe("notes");
    expect(findForbiddenKey({ name: "ok" })).toBeNull();
  });
});
