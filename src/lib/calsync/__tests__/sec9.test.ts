import { describe, expect, it } from "vitest";
import { buildIcs, escapeIcsText } from "../ics";
import { createOauthState, verifyOauthState } from "../oauth";

describe("sec9 calsync", () => {
  it("escapes semicolons and strips control chars so a name cannot inject properties", () => {
    expect(escapeIcsText("a;b,c")).toBe("a\\;b\\,c");
    const evil = "Bob\r\nATTENDEE:mailto:x@evil.test\u0085 DESCRIPTION:pwn";
    const out = buildIcs([{ id: "1", summary: evil, startsAt: "2026-11-10T10:00:00Z", endsAt: "2026-11-10T11:00:00Z" }], { name: "t" });
    const lines = out.split("\r\n");
    expect(lines.some((l) => l.startsWith("ATTENDEE:"))).toBe(false);
    expect(lines.some((l) => l.startsWith("DESCRIPTION:"))).toBe(false);
  });
  it("oauth state is bound to the initiating org", () => {
    const s = createOauthState("google", 1_000_000, "org-a");
    expect(verifyOauthState(s, s, "google", 1_000_500, "org-a")).toBe(true);
    expect(verifyOauthState(s, s, "google", 1_000_500, "org-b")).toBe(false);
  });
});
