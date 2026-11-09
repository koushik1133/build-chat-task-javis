import { describe, expect, it } from "vitest";
import { categoryOf, filterInbox, isSnoozed, linkOf, snoozeUntil, type InboxItem } from "../pure";

const mk = (o: Partial<InboxItem>): InboxItem => ({ id: "i", title: "t", body: null, category: "billing", read: false, created_at: "2026-01-01T00:00:00Z", snoozed_until: null, href: null, ...o });

describe("snoozeUntil", () => {
  const now = new Date("2026-03-10T15:30:00Z");
  it("adds one hour", () => {
    expect(snoozeUntil("1h", now).toISOString()).toBe("2026-03-10T16:30:00.000Z");
  });
  it("tomorrow is 09:00 local (UTC)", () => {
    expect(snoozeUntil("tomorrow", now, 0).toISOString()).toBe("2026-03-11T09:00:00.000Z");
  });
  it("respects the browser offset (UTC-5 => offset 300)", () => {
    // 15:30Z is 10:30 local on Mar 10; tomorrow 09:00 local = 14:00Z on Mar 11.
    expect(snoozeUntil("tomorrow", now, 300).toISOString()).toBe("2026-03-11T14:00:00.000Z");
  });
  it("crosses the local date line (UTC+5:30 => offset -330)", () => {
    // 22:00Z is 03:30 local on Mar 11; tomorrow 09:00 local = Mar 12 03:30Z.
    expect(snoozeUntil("tomorrow", new Date("2026-03-10T22:00:00Z"), -330).toISOString()).toBe("2026-03-12T03:30:00.000Z");
  });
});

describe("filterInbox", () => {
  const now = new Date("2026-03-10T12:00:00Z");
  const items = [
    mk({ id: "a" }),
    mk({ id: "b", read: true }),
    mk({ id: "c", category: "helpdesk" }),
    mk({ id: "d", snoozed_until: "2026-03-10T13:00:00Z" }),
    mk({ id: "e", snoozed_until: "2026-03-10T11:00:00Z" }),
  ];
  it("hides items snoozed into the future but returns elapsed snoozes", () => {
    expect(isSnoozed(items[3], now)).toBe(true);
    expect(isSnoozed(items[4], now)).toBe(false);
    expect(filterInbox(items, {}, now).map((i) => i.id)).toEqual(["a", "b", "c", "e"]);
  });
  it("filters unread and category", () => {
    expect(filterInbox(items, { unread: true }, now).map((i) => i.id)).toEqual(["a", "c", "e"]);
    expect(filterInbox(items, { category: "helpdesk" }, now).map((i) => i.id)).toEqual(["c"]);
  });
});

describe("data helpers", () => {
  it("reads category and safe links", () => {
    expect(categoryOf({ category: "billing" })).toBe("billing");
    expect(categoryOf(null)).toBe("general");
    expect(linkOf({ href: "/billing" })).toBe("/billing");
    expect(linkOf({ href: "//evil" })).toBeNull();
    expect(linkOf({ url: "https://x" })).toBeNull();
  });
});

describe("linkOf hardening", () => {
  it("rejects backslash and control-char open redirects", () => {
    expect(linkOf({ href: "/\\evil.com" })).toBeNull();
    expect(linkOf({ href: "/\t/evil.com" })).toBeNull();
    expect(linkOf({ href: "/tasks?task=1" })).toBe("/tasks?task=1");
  });
});
