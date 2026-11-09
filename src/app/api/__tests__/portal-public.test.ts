import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const enqueue = vi.fn(async () => "id");
const contactLookup = vi.fn();

vi.mock("@/lib/dsql", () => ({ query: vi.fn(), queryOne: (...a: unknown[]) => contactLookup(...a), withRetry: (fn: () => unknown) => fn(), transaction: vi.fn() }));
vi.mock("@/lib/calendar/booking", () => ({ resolveOrgBySlug: async (slug: string) => (slug === "acme" ? { dataId: "org1", name: "Acme", slug } : null) }));
vi.mock("@/lib/notifications/outbox", () => ({ enqueueNotification: (...a: unknown[]) => (enqueue as (...x: unknown[]) => unknown)(...a) }));
vi.mock("@/lib/share-tokens", () => ({ issueShareToken: async () => ({ token: "tok", path: "/p/portal/tok", url: "u", expiresAt: "" }), appOrigin: () => "http://x" }));
vi.mock("@/lib/portal-auth", () => ({ clientIp: (r: Request) => r.headers.get("x-forwarded-for") ?? "anon", authPortalToken: async (t: string) => (t === "good" ? { dataId: "org1", contactId: "c1" } : null) }));
const receive = vi.fn(async () => ({ id: "m1", direction: "in", body: "hi", read_at: null, created_at: new Date().toISOString() }));
vi.mock("@/lib/portal-messages", async () => {
  const actual = await vi.importActual<typeof import("@/lib/portal-messages")>("@/lib/portal-messages");
  return { ...actual, receiveFromContact: (...a: unknown[]) => (receive as (...x: unknown[]) => unknown)(...a), listThread: async () => [], markReadByContact: async () => undefined };
});

import { POST as requestLink } from "@/app/api/p/portal/request-link/route";
import { POST as sendMessage, GET as listMessages } from "@/app/api/p/portal/[token]/messages/route";

const post = (url: string, body: unknown, ip = "9.9.9.9") =>
  new NextRequest(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-forwarded-for": ip } });

describe("POST /api/p/portal/request-link", () => {
  beforeEach(() => {
    enqueue.mockClear();
    contactLookup.mockReset();
  });

  it("returns an identical 202 for known email, unknown email, unknown org and malformed input", async () => {
    contactLookup.mockResolvedValueOnce({ id: "c1", full_name: "Jo" });
    const known = await requestLink(post("/api/p/portal/request-link", { org: "acme", email: "jo@example.com" }, "10.0.0.1"));
    contactLookup.mockResolvedValueOnce(null);
    const unknownEmail = await requestLink(post("/api/p/portal/request-link", { org: "acme", email: "nobody@example.com" }, "10.0.0.2"));
    const unknownOrg = await requestLink(post("/api/p/portal/request-link", { org: "nope", email: "jo@example.com" }, "10.0.0.3"));
    const malformed = await requestLink(post("/api/p/portal/request-link", { org: "acme", email: "not-an-email" }, "10.0.0.4"));
    const bodies = await Promise.all([known, unknownEmail, unknownOrg, malformed].map((r) => r.json()));
    for (const r of [known, unknownEmail, unknownOrg, malformed]) expect(r.status).toBe(202);
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("takes a similar minimum time for hits and misses (timing parity floor)", async () => {
    contactLookup.mockResolvedValue(null);
    const t0 = Date.now();
    await requestLink(post("/api/p/portal/request-link", { org: "nope", email: "a@example.com" }, "10.0.1.1"));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
    contactLookup.mockResolvedValue({ id: "c1", full_name: "Jo" });
    const t1 = Date.now();
    await requestLink(post("/api/p/portal/request-link", { org: "acme", email: "b@example.com" }, "10.0.1.2"));
    expect(Date.now() - t1).toBeGreaterThanOrEqual(300);
  });

  it("rate-limits per address without revealing existence", async () => {
    contactLookup.mockResolvedValue({ id: "c1", full_name: "Jo" });
    for (let i = 0; i < 5; i++) {
      const r = await requestLink(post("/api/p/portal/request-link", { org: "acme", email: "spam@example.com" }, `10.1.0.${i}`));
      expect(r.status).toBe(202);
    }
    expect(enqueue.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

describe("portal messages route", () => {
  const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
  it("404s for a bad token", async () => {
    const r = await listMessages(new NextRequest("http://localhost/api/p/portal/bad/messages", { headers: { "x-forwarded-for": "7.7.7.7" } }), ctx("bad"));
    expect(r.status).toBe(404);
  });
  it("rejects over-length bodies and rate-limits bursts", async () => {
    const long = await sendMessage(post("/api/p/portal/good/messages", { body: "x".repeat(5000) }, "8.8.8.1"), ctx("good"));
    expect(long.status).toBe(400);
    receive.mockClear();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await sendMessage(post("/api/p/portal/good/messages", { body: `m${i}` }, "8.8.8.2"), ctx("good"))).status);
    expect(statuses.filter((s) => s === 201).length).toBeLessThanOrEqual(10);
    expect(statuses).toContain(429);
  });
});
