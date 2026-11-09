import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/** Anonymous widget intake must be bounded per IP (lead capture) and refuse closed sessions. */
const db = vi.hoisted(() => ({
  query: vi.fn(async () => []),
  queryOne: vi.fn<(sql: string, values?: unknown[]) => Promise<unknown>>(async () => null),
  withRetry: vi.fn(async <T,>(fn: () => Promise<T>) => fn()),
}));
vi.mock("@/lib/dsql", () => db);
vi.mock("@/lib/lead-enrichment", () => ({ enrichLead: vi.fn(async () => undefined) }));
vi.mock("@/lib/events/bus", () => ({ emitEvent: vi.fn(async () => undefined) }));
vi.mock("@/lib/privacy/consent", () => ({ recordConsent: vi.fn(async () => undefined) }));
vi.mock("@/lib/cors", () => ({
  siteAllowedOrigins: vi.fn(async () => []),
  corsHeadersFor: () => ({}),
  corsPreflight: () => new Response(null, { status: 204 }),
  parseOriginList: () => [],
}));
const sessions = vi.hoisted(() => ({
  resolveSession: vi.fn<(siteId: string, token: unknown) => Promise<unknown>>(async () => null),
  touchSession: vi.fn(async () => undefined),
}));
vi.mock("@/lib/webchat/session", () => sessions);
vi.mock("@/lib/webchat/service", () => ({ pollMessages: vi.fn(async () => ({ messages: [], status: "open" })), postVisitorMessage: vi.fn() }));

import { POST as leadPost } from "@/app/api/leads/widget/[siteId]/route";
import { POST as msgPost, GET as msgGet } from "@/app/api/widget/chat/[siteId]/messages/route";
import { resetRateLimits } from "@/lib/request-limits";

const SITE = "11111111-1111-4111-8111-111111111111";
const ctx = { params: Promise.resolve({ siteId: SITE }) };
const TOKEN = "b".repeat(32);

function lead(ip: string) {
  return new NextRequest(`https://x.test/api/leads/widget/${SITE}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({ name: "A", email: "a@b.test" }) });
}

describe("widget intake limits", () => {
  beforeEach(() => {
    resetRateLimits();
    db.queryOne.mockReset();
    db.queryOne.mockImplementation(async (sql: string) => (/FROM sites/.test(sql) ? { user_id: "org1" } : { id: "lead" }));
    sessions.resolveSession.mockReset();
  });

  it("lead capture: 31st submission from one IP in an hour is refused", async () => {
    for (let i = 0; i < 30; i++) expect((await leadPost(lead("9.9.9.9"), ctx)).status).toBe(200);
    expect((await leadPost(lead("9.9.9.9"), ctx)).status).toBe(429);
    expect((await leadPost(lead("8.8.8.8"), ctx)).status).toBe(200);
  });

  it("chat messages: a token in the query string is not accepted", async () => {
    sessions.resolveSession.mockImplementation(async (_s, token) => (token === TOKEN ? { id: "s1", status: "open", user_id: "org1", site_id: SITE } : null));
    const viaQuery = await msgGet(new NextRequest(`https://x.test/api/widget/chat/${SITE}/messages?token=${TOKEN}`), ctx);
    expect(viaQuery.status).toBe(401);
    const viaHeader = await msgGet(new NextRequest(`https://x.test/api/widget/chat/${SITE}/messages`, { headers: { authorization: `Bearer ${TOKEN}` } }), ctx);
    expect(viaHeader.status).toBe(200);
  });

  it("chat messages: closed sessions cannot post", async () => {
    sessions.resolveSession.mockResolvedValue({ id: "s1", status: "closed", user_id: "org1", site_id: SITE });
    const res = await msgPost(new NextRequest(`https://x.test/api/widget/chat/${SITE}/messages`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) }), ctx);
    expect(res.status).toBe(410);
  });
});
