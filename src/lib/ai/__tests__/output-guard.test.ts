import { describe, expect, it } from "vitest";
import { guardCustomerReply, promptPreview, redactForLog, redactUntrustedSpans } from "../output-guard";
import { wrapUntrusted } from "../untrusted";

describe("guardCustomerReply", () => {
  it("passes a normal reply", () => {
    expect(guardCustomerReply("Thanks! We open at 9am. A team member will confirm.").ok).toBe(true);
  });
  const bad: [string, string][] = [
    ["key", "Use sk-abcdefghijklmnop1234 to log in"],
    ["key", "gsk_abcdefghijklmnop1234567"],
    ["key", "AIzaSyA1234567890abcdefghijk"],
    ["key", "kh_live_abcdefghijkl"],
    ["key", "whsec_abcdefghijklmnop"],
    ["key", "Authorization: Bearer abcdefghijklmnopqrstuv"],
    ["key", "token eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4"],
    ["leak", "My system prompt is: be nice"],
    ["leak", "## Untrusted content rules ..."],
    ["id", "Your record is 3f2b8c1e-1a2b-4c3d-8e4f-123456789abc"],
    ["internal", "see /api/v1/contacts for details"],
    ["internal", "http://localhost:3001/admin"],
    ["merge", "Hello {{contact.first_name}}"],
  ];
  for (const [kind, text] of bad) {
    it(`blocks ${kind}: ${text.slice(0, 30)}`, () => {
      expect(guardCustomerReply(text).ok).toBe(false);
    });
  }
  it("blocks overlong and empty", () => {
    expect(guardCustomerReply("x".repeat(2000)).ok).toBe(false);
    expect(guardCustomerReply("  ").ok).toBe(false);
  });
});

describe("redaction", () => {
  it("redacts emails, phones, cards, jwt and keys", () => {
    const t = "mail a@b.com call +1 (415) 555-2671 card 4242 4242 4242 4242 jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4 key sk-abcdefghijklmnop1234";
    const r = redactForLog(t);
    expect(r).not.toMatch(/a@b\.com|555-2671|4242|eyJ|sk-abc/);
    expect(r).toContain("[email]");
  });
  it("promptPreview truncates", () => {
    expect(promptPreview("x".repeat(1000), 50).length).toBeLessThanOrEqual(51);
  });
  it("redacts only untrusted spans", () => {
    const text = `internal a@b.com\n${wrapUntrusted("sms", "reach me at c@d.com", { nonce: "aa11bb22" })}`;
    const out = redactUntrustedSpans(text);
    expect(out).toContain("a@b.com");
    expect(out).not.toContain("c@d.com");
  });
});
