import { describe, expect, it } from "vitest";
import { clientIp, normalizeIp } from "../request-limits";

const req = (xff?: string, real?: string) =>
  new Request("http://x/", { headers: { ...(xff !== undefined ? { "x-forwarded-for": xff } : {}), ...(real ? { "x-real-ip": real } : {}) } });

describe("clientIp trusted hops", () => {
  it("indexes from the right", () => {
    expect(clientIp(req("6.6.6.6, 1.1.1.1"), 1)).toBe("1.1.1.1");
    expect(clientIp(req("6.6.6.6, 1.1.1.1, 10.0.0.1"), 2)).toBe("1.1.1.1");
    expect(clientIp(req("6.6.6.6, 1.1.1.1"), 0)).toBe("6.6.6.6");
  });
  it("shorter list than hops falls back to first; empty entries and whitespace ignored", () => {
    expect(clientIp(req("1.1.1.1"), 3)).toBe("1.1.1.1");
    expect(clientIp(req(" , 6.6.6.6 ,, 1.1.1.1 , "), 1)).toBe("1.1.1.1");
    expect(clientIp(req(" , "), 1)).toBe("unknown");
    expect(clientIp(req(undefined, "9.9.9.9"), 1)).toBe("9.9.9.9");
    expect(clientIp(req(), 1)).toBe("unknown");
  });
  it("spoofed leading hops cannot rotate the key", () => {
    expect(clientIp(req("a, b, 1.1.1.1"), 1)).toBe(clientIp(req("c, 1.1.1.1"), 1));
  });
  it("normalises IPv4-mapped IPv6, ports and brackets", () => {
    expect(normalizeIp("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(normalizeIp("1.2.3.4:5555")).toBe("1.2.3.4");
    expect(normalizeIp("[2001:DB8::1]:443")).toBe("2001:db8::1");
    expect(clientIp(req("::FFFF:1.1.1.1"), 1)).toBe("1.1.1.1");
  });
});
