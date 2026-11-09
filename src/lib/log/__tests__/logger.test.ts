import { describe, expect, it, vi } from "vitest";
import { buildRecord, configuredLevel, formatRecord, logger } from "../logger";
import { getRequestContext, hashOrg, normaliseRequestId, routeGroup, runWithContext, setRequestOrg, withRequestContext } from "../context";
import { renderPrometheus, resetMetrics } from "@/lib/metrics/registry";

describe("logger", () => {
  it("builds the JSON shape with redaction", () => {
    const rec = buildRecord("error", "failed for bob@example.com", { err: new Error("Bearer abcdefghijklmnop1234 broke"), ms: 12.6, route: "/api/x", password: "hunter2", note: "call +1 415 555 0100" }, new Date("2026-01-02T03:04:05Z"));
    expect(rec.ts).toBe("2026-01-02T03:04:05.000Z");
    expect(rec.level).toBe("error");
    expect(rec.msg).toBe("failed for [email]");
    expect(rec.route).toBe("/api/x");
    expect(rec.ms).toBe(13);
    expect(String(rec.err)).toContain("Bearer [token]");
    expect(rec.password).toBe("[redacted]");
    expect(rec.note).toBe("call [phone]");
    expect(JSON.parse(formatRecord(rec, false)).level).toBe("error");
  });

  it("honours LOG_LEVEL", () => {
    expect(configuredLevel({ LOG_LEVEL: "debug" })).toBeLessThan(configuredLevel({ LOG_LEVEL: "error" }));
    expect(configuredLevel({ LOG_LEVEL: "silent" })).toBe(Infinity);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logger.error("boom");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("carries request id and hashed org from context", () => {
    runWithContext({ reqId: "req-12345678", route: "/api/y", org: null }, () => {
      setRequestOrg("org-secret-id");
      const rec = buildRecord("info", "hi");
      expect(rec.req_id).toBe("req-12345678");
      expect(rec.org).toBe(hashOrg("org-secret-id"));
      expect(rec.org).not.toContain("secret");
      expect(getRequestContext()?.route).toBe("/api/y");
    });
    expect(getRequestContext()).toBeUndefined();
  });
});

describe("request context", () => {
  it("normalises request ids", () => {
    expect(normaliseRequestId("abc-12345678")).toBe("abc-12345678");
    expect(normaliseRequestId("bad id\nwith newline")).not.toContain("\n");
    expect(normaliseRequestId(null)).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("groups routes", () => {
    expect(routeGroup("/api/v1/contacts")).toBe("api_v1");
    expect(routeGroup("/api/cron/agents")).toBe("cron");
    expect(routeGroup("/api/shop/acme")).toBe("shop");
    expect(routeGroup("/api/p/portal/tok")).toBe("portal");
  });
  it("echoes x-request-id, exposes it to the handler and records a request metric", async () => {
    resetMetrics();
    let seen: string | undefined;
    const h = withRequestContext(async () => { seen = getRequestContext()?.reqId; return new Response("ok", { status: 201 }); });
    const res = await h(new Request("http://x/api/shop/a", { headers: { "x-request-id": "incoming-req-1" } }));
    expect(seen).toBe("incoming-req-1");
    expect(res.headers.get("x-request-id")).toBe("incoming-req-1");
    expect(renderPrometheus()).toContain('kh_http_requests_total{group="shop",status="2xx"} 1');
  });
  it("mints an id when none is supplied", async () => {
    const h = withRequestContext(async () => new Response("ok"));
    const res = await h(new Request("http://x/api/widget/z"));
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });
});
