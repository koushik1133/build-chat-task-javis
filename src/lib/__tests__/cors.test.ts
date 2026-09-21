import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/dsql", () => ({ query: vi.fn(), queryOne: vi.fn() }));

import { corsHeadersFor, corsPreflight, parseOriginList, resolveAllowedOrigin } from "@/lib/cors";

function req(origin?: string) {
  return new Request("https://app.test/api/x", { headers: origin ? { origin } : {} });
}

describe("parseOriginList", () => {
  it("accepts JSON arrays and comma lists, normalising to origins", () => {
    expect(parseOriginList('["https://a.com/path", "b.com"]')).toEqual(["https://a.com", "https://b.com"]);
    expect(parseOriginList("https://A.com, https://a.com ,\nhttp://c.io:8080")).toEqual([
      "https://a.com",
      "http://c.io:8080",
    ]);
    expect(parseOriginList(null)).toEqual([]);
    expect(parseOriginList("[not json")).toEqual([]);
  });
});

describe("resolveAllowedOrigin", () => {
  it("wildcards when nothing is configured", () => {
    expect(resolveAllowedOrigin("https://x.com", [])).toBe("*");
    expect(resolveAllowedOrigin(null, ["*"])).toBe("*");
  });
  it("echoes a matching origin and rejects others", () => {
    expect(resolveAllowedOrigin("https://a.com", ["https://a.com"])).toBe("https://a.com");
    expect(resolveAllowedOrigin("https://evil.com", ["https://a.com"])).toBeNull();
    expect(resolveAllowedOrigin(null, ["https://a.com"])).toBeNull();
  });
});

describe("corsHeadersFor / corsPreflight", () => {
  it("omits Access-Control-Allow-Origin for a disallowed origin", () => {
    const h = corsHeadersFor(req("https://evil.com"), { allowedOrigins: ["https://a.com"] });
    expect(h["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(h.Vary).toBe("Origin");
  });
  it("sets the allowed origin and methods", () => {
    const h = corsHeadersFor(req("https://a.com"), { allowedOrigins: ["https://a.com"], methods: "GET, POST, OPTIONS" });
    expect(h["Access-Control-Allow-Origin"]).toBe("https://a.com");
    expect(h["Access-Control-Allow-Methods"]).toBe("GET, POST, OPTIONS");
  });
  it("preflight returns 204 with headers", () => {
    const res = corsPreflight(req("https://a.com"), { allowedOrigins: [] });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
