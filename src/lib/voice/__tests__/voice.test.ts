import { describe, expect, it } from "vitest";
import { buildCampaignTwiml, buildGatherResultTwiml, buildHangupTwiml, escapeXml, firstNameOf, interpretDigits, mergeScript, webhookUrl } from "@/lib/voice/twiml";
import { canDialNow, filterDnc, isRetryDue, isWithinWindow, localClock, normalizePhone, parseHm } from "@/lib/voice/window";
import { canTransition } from "@/lib/voice/campaigns";

describe("script merge + TwiML", () => {
  it("merges {{first_name}} and friends, dropping unknown fields cleanly", () => {
    expect(mergeScript("Hi {{first_name}}, this is {{company}} calling about {{ unknown }} your order.", { first_name: "Ana", company: "Acme" })).toBe(
      "Hi Ana, this is Acme calling about your order."
    );
    expect(mergeScript("Hello {{first_name}}!", {})).toBe("Hello!");
    expect(firstNameOf("  Ana María López ")).toBe("Ana");
    expect(firstNameOf(null)).toBe("");
  });

  it("escapes every XML metacharacter in the script and action URL", () => {
    expect(escapeXml(`<a href="x">Tom & Jerry's</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&apos;s&lt;/a&gt;");
    const xml = buildCampaignTwiml({ script: `Hi <Ana> & "friends"</Say><Hangup/>`, voice: 'x" onload="y', gatherAction: "https://app.test/api/voice/campaigns/webhook?target=1&kind=gather" });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><Response>')).toBe(true);
    expect(xml).toContain("Hi &lt;Ana&gt; &amp; &quot;friends&quot;&lt;/Say&gt;&lt;Hangup/&gt;");
    expect(xml).not.toContain("<Ana>");
    expect(xml).toContain('voice="x&quot; onload=&quot;y"');
    expect(xml).toContain('action="https://app.test/api/voice/campaigns/webhook?target=1&amp;kind=gather"');
    expect(xml).toContain('<Gather numDigits="1"');
    expect(xml.endsWith("<Hangup/></Response>")).toBe(true);
  });

  it("interprets digits and builds closing TwiML", () => {
    expect(interpretDigits("1")).toBe("interested");
    expect(interpretDigits("2")).toBe("opted_out");
    expect(interpretDigits("")).toBe("no_input");
    expect(interpretDigits(undefined)).toBe("no_input");
    expect(buildGatherResultTwiml("opted_out", "alice")).toContain("removed you from our call list");
    expect(buildHangupTwiml()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    expect(buildHangupTwiml("Bye <3")).toContain("Bye &lt;3");
  });

  it("builds webhook URLs with target + kind in the query", () => {
    const u = new URL(webhookUrl("https://app.test", "t 1", "status"));
    expect(u.pathname).toBe("/api/voice/campaigns/webhook");
    expect(u.searchParams.get("target")).toBe("t 1");
    expect(u.searchParams.get("kind")).toBe("status");
  });
});

describe("calling window / timezone", () => {
  // 2025-06-02 is a Monday. 14:30Z = 10:30 in New York (EDT), 20:00 in Kolkata, 23:30 in Tokyo.
  const monday = new Date("2025-06-02T14:30:00Z");
  const saturday = new Date("2025-06-07T14:30:00Z");

  it("parses HH:MM and reads the local clock in a timezone", () => {
    expect(parseHm("09:00")).toBe(540);
    expect(parseHm("9:05")).toBe(545);
    expect(parseHm("24:00")).toBeNull();
    expect(parseHm("nine")).toBeNull();
    expect(localClock(monday, "America/New_York")).toEqual({ minutes: 10 * 60 + 30, weekday: 1 });
    expect(localClock(monday, "Asia/Kolkata").minutes).toBe(20 * 60);
    expect(localClock(monday, "Not/AZone").minutes).toBe(14 * 60 + 30); // falls back to UTC
  });

  it("respects the window in the campaign's own timezone", () => {
    const w = { window_start: "09:00", window_end: "18:00" };
    expect(isWithinWindow(monday, { ...w, timezone: "America/New_York" })).toBe(true);
    expect(isWithinWindow(monday, { ...w, timezone: "Asia/Kolkata" })).toBe(false);
    expect(isWithinWindow(monday, { ...w, timezone: "Asia/Tokyo" })).toBe(false);
    expect(isWithinWindow(monday, { ...w, timezone: "UTC" })).toBe(true);
  });

  it("handles overnight windows, weekends and malformed times (fail closed)", () => {
    expect(isWithinWindow(monday, { window_start: "22:00", window_end: "06:00", timezone: "Asia/Tokyo" })).toBe(true); // 23:30 local
    expect(isWithinWindow(monday, { window_start: "22:00", window_end: "06:00", timezone: "UTC" })).toBe(false);
    expect(isWithinWindow(saturday, { window_start: "09:00", window_end: "18:00", timezone: "UTC" })).toBe(false);
    expect(isWithinWindow(saturday, { window_start: "09:00", window_end: "18:00", timezone: "UTC", weekdaysOnly: false })).toBe(true);
    expect(isWithinWindow(monday, { window_start: "09:00", window_end: "09:00", timezone: "UTC" })).toBe(false);
    expect(isWithinWindow(monday, { window_start: "", window_end: "18:00", timezone: "UTC" })).toBe(false);
  });

  it("canDialNow needs running status, a passed schedule and an open window", () => {
    const base = { window_start: "09:00", window_end: "18:00", timezone: "UTC", schedule_at: null };
    expect(canDialNow(monday, { ...base, status: "running" })).toBe(true);
    expect(canDialNow(monday, { ...base, status: "paused" })).toBe(false);
    expect(canDialNow(monday, { ...base, status: "running", schedule_at: "2025-06-03T00:00:00Z" })).toBe(false);
    expect(canDialNow(monday, { ...base, status: "running", schedule_at: "2025-06-01T00:00:00Z" })).toBe(true);
  });

  it("retries only due, retryable targets under max_attempts", () => {
    const now = new Date("2025-06-02T14:30:00Z");
    expect(isRetryDue({ status: "queued", attempts: 0, last_attempt_at: null }, 2, now)).toBe(true);
    expect(isRetryDue({ status: "no_answer", attempts: 1, last_attempt_at: "2025-06-02T14:00:00Z" }, 2, now)).toBe(false); // 30 min ago
    expect(isRetryDue({ status: "no_answer", attempts: 1, last_attempt_at: "2025-06-02T12:00:00Z" }, 2, now)).toBe(true);
    expect(isRetryDue({ status: "no_answer", attempts: 2, last_attempt_at: "2025-06-02T12:00:00Z" }, 2, now)).toBe(false);
    expect(isRetryDue({ status: "answered", attempts: 1, last_attempt_at: null }, 5, now)).toBe(false);
    expect(isRetryDue({ status: "opted_out", attempts: 0, last_attempt_at: null }, 5, now)).toBe(false);
  });
});

describe("do-not-call filtering", () => {
  it("normalises phones", () => {
    expect(normalizePhone("(555) 010-0200")).toBe("+5550100200");
    expect(normalizePhone("+1 555 010 0200")).toBe("+15550100200");
    expect(normalizePhone("123")).toBe("");
    expect(normalizePhone(null)).toBe("");
  });

  it("blocks opted-out phones, opted-out contacts and do_not_call tags", () => {
    const targets = [
      { phone: "+15550100001", contact_id: "a", tags: '["vip"]' },
      { phone: "+1 (555) 010-0002", contact_id: "b", tags: '["do_not_call"]' },
      { phone: "+15550100003", contact_id: "c", tags: ["x"] },
      { phone: "+15550100004", contact_id: null, tags: null },
      { phone: "+15550100005", contact_id: "e", tags: "not json" },
    ];
    const { allowed, blocked } = filterDnc(targets, { phones: ["+1 555-010-0004", "+15550100009"], contactIds: ["c"] });
    expect(allowed.map((t) => t.phone)).toEqual(["+15550100001", "+15550100005"]);
    expect(blocked.map((t) => t.contact_id)).toEqual(["b", "c", null]);
  });
});

describe("campaign status transitions", () => {
  it("allows the supported lifecycle only", () => {
    expect(canTransition("draft", "running")).toBe(true);
    expect(canTransition("running", "paused")).toBe(true);
    expect(canTransition("paused", "running")).toBe(true);
    expect(canTransition("done", "running")).toBe(false);
    expect(canTransition("draft", "done")).toBe(false);
    expect(canTransition("running", "running")).toBe(true);
  });
});
