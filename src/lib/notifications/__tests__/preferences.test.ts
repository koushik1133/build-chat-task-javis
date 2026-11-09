import { describe, expect, it } from "vitest";
import { applyPatch, decideAllowed, defaultMatrix, parseMatrix, type NotificationPreferences } from "@/lib/notifications/preferences";

const base: NotificationPreferences = { member_user_id: "m1", email: null, channels: defaultMatrix(), digest: "off", digest_hour: 8, digest_weekday: 1, quiet_hours: null, updated_at: null };

describe("notification preference gating", () => {
  it("defaults allow everything except SMS", () => {
    expect(decideAllowed(base, "helpdesk", "in_app", new Date(), "UTC")).toEqual({ allowed: true, deferUntil: null, reason: "ok" });
    expect(decideAllowed(base, "helpdesk", "sms", new Date(), "UTC").reason).toBe("channel_off");
  });

  it("a switched-off channel blocks only that category/channel", () => {
    const p = applyPatch(base, { channels: { helpdesk: { in_app: false } } });
    expect(decideAllowed(p, "helpdesk", "in_app", new Date(), "UTC").allowed).toBe(false);
    expect(decideAllowed(p, "helpdesk", "email", new Date(), "UTC").allowed).toBe(true);
    expect(decideAllowed(p, "billing", "in_app", new Date(), "UTC").allowed).toBe(true);
  });

  it("quiet hours defer push/sms but never in-app or email", () => {
    const p = applyPatch(base, { quiet_hours: { start: "22:00", end: "07:00" }, channels: { approvals: { sms: true } } });
    const late = new Date("2026-03-15T23:00:00Z");
    expect(decideAllowed(p, "approvals", "push", late, "UTC")).toEqual({ allowed: true, deferUntil: new Date("2026-03-16T07:00:00Z"), reason: "quiet_hours" });
    expect(decideAllowed(p, "approvals", "sms", late, "UTC").reason).toBe("quiet_hours");
    expect(decideAllowed(p, "approvals", "email", late, "UTC").reason).toBe("ok");
    expect(decideAllowed(p, "approvals", "push", new Date("2026-03-15T12:00:00Z"), "UTC").reason).toBe("ok");
  });

  it("parses stored JSON leniently", () => {
    const m = parseMatrix('{"billing":{"email":false,"junk":1},"unknown":{"email":false}}');
    expect(m.billing.email).toBe(false);
    expect(m.billing.in_app).toBe(true);
    expect(parseMatrix("not json").helpdesk.email).toBe(true);
  });
});
