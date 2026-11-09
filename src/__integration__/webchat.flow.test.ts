/**
 * Web chat widget end-to-end: public config → session (CORS) → visitor message
 * with the LLM mocked (auto-reply on → inline reply; off → pending for a human)
 * → poll → handoff creates contact + lead + consent → staff reply via the
 * messaging send path is visible to the visitor → close → rate limit 429.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { api, call, cleanupDataIds, createTestOrg, describeDb, expectEvent, req, setScope, sql, sqlOne, type TestOrg } from "./setup";

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));

const llm = vi.hoisted(() => ({ calls: 0, reply: "Hello from the receptionist! How can I help?" }));
vi.mock("@/lib/llm/router", async () => {
  const actual = await vi.importActual<typeof import("@/lib/llm/router")>("@/lib/llm/router");
  return {
    ...actual,
    completeWithTools: async () => {
      llm.calls++;
      return { content: JSON.stringify({ intent: "support", reply: llm.reply }), toolCalls: [], provider: "mock", model: "mock-1", promptTokens: 10, completionTokens: 10, finishReason: "stop" };
    },
  };
});

const ORIGIN = "https://shop.example.test";
interface Msg { role: string; content: string; ts: string }

describeDb("webchat flow", () => {
  let org: TestOrg;
  let siteId: string;
  let token: string;
  let sessionId: string;
  let lastTs: string | null = null;

  beforeAll(async () => {
    org = await createTestOrg("webchat");
    setScope(org);
    siteId = randomUUID();
    await sql(
      `INSERT INTO sites (id, user_id, title, html, allowed_origins, consent_text, widget_config, created_at, updated_at) VALUES ($1, $2, 'Shop', '<html><body><h1>Hi</h1></body></html>', $3, 'Keep me posted', $4, NOW(), NOW())`,
      [siteId, org.dataId, ORIGIN, JSON.stringify({ modes: { chat: true, lead: true, booking: false, help: false }, greeting: "Welcome!", consentMode: "required" })]
    );
    await sql(`INSERT INTO user_integrations (user_id, messaging_auto_reply) VALUES ($1, TRUE)`, [org.dataId]);
  });
  afterAll(async () => {
    await cleanupDataIds([org.dataId]);
  });

  it("serves the public config with CORS and 404s unknown sites", async () => {
    const cfg = await import("@/app/api/widget/config/[siteId]/route");
    const r = await call<{ enabled: boolean; modes: string[]; greeting: string; consentText: string; consentMode: string; orgSlug: string }>(cfg.GET, req(`/api/widget/config/${siteId}`, { headers: { origin: ORIGIN } }), { siteId }, 200);
    expect(r.res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(r.body.enabled).toBe(true);
    expect(r.body.modes).toEqual(["chat", "lead"]);
    expect(r.body.greeting).toBe("Welcome!");
    expect(r.body.consentText).toBe("Keep me posted");
    expect(r.body.consentMode).toBe("required");
    expect(r.body.orgSlug).toBe(org.slug);
    await call(cfg.GET, req(`/api/widget/config/${randomUUID()}`), { siteId: randomUUID() }, 404);
    await call(cfg.GET, req(`/api/widget/config/nonexistent`), { siteId: "nonexistent" }, 404);
    const foreign = await call(cfg.GET, req(`/api/widget/config/${siteId}`, { headers: { origin: "https://evil.example.test" } }), { siteId }, 200);
    expect(foreign.res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("starts a session (preflight + 201) and hashes the token at rest", async () => {
    const route = await import("@/app/api/widget/chat/[siteId]/session/route");
    const pre = await call(route.OPTIONS, req(`/api/widget/chat/${siteId}/session`, { method: "OPTIONS", headers: { origin: ORIGIN } }), { siteId }, 204);
    expect(pre.res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(pre.res.headers.get("access-control-allow-methods")).toContain("POST");
    await api(route.POST, `/api/widget/chat/nonexistent/session`, { json: {}, params: { siteId: "nonexistent" }, expect: 404 });
    await api(route.POST, `/api/widget/chat/${siteId}/session`, { json: { bogus: 1 }, params: { siteId }, expect: 400 });
    const r = await api<{ sessionId: string; token: string; expiresAt: string; status: string }>(route.POST, `/api/widget/chat/${siteId}/session`, {
      json: { visitorId: "visitor-1", pageUrl: `${ORIGIN}/pricing` },
      headers: { origin: ORIGIN, "x-forwarded-for": "203.0.113.9" },
      params: { siteId },
      expect: 201,
    });
    token = r.body.token;
    sessionId = r.body.sessionId;
    expect(r.body.status).toBe("open");
    expect(Date.parse(r.body.expiresAt) - Date.now()).toBeGreaterThan(29 * 86_400_000);
    const row = await sqlOne<{ session_token_hash: string; page_url: string; ip_hash: string | null }>(`SELECT session_token_hash, page_url, ip_hash FROM chat_sessions WHERE id = $1`, [sessionId]);
    expect(row?.session_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.session_token_hash).not.toBe(token);
    expect(row?.page_url).toBe(`${ORIGIN}/pricing`);
    expect(row?.ip_hash).toBeTruthy();
    await expectEvent(org.dataId, "webchat.session_started", sessionId);
  });

  it("answers inline when auto-reply is on, and the thread appears in the staff inbox as webchat", async () => {
    const route = await import("@/app/api/widget/chat/[siteId]/messages/route");
    await api(route.POST, `/api/widget/chat/${siteId}/messages`, { json: { text: "hi" }, params: { siteId }, expect: 401 });
    const r = await api<{ reply: Msg | null; pendingHuman: boolean; messages: Msg[]; now: string }>(route.POST, `/api/widget/chat/${siteId}/messages`, {
      json: { text: "Do you ship to Canada?" },
      headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
      params: { siteId },
      expect: 201,
    });
    expect(llm.calls).toBe(1);
    expect(r.body.pendingHuman).toBe(false);
    expect(r.body.reply?.content).toBe(llm.reply);
    expect(r.body.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    lastTs = r.body.messages[r.body.messages.length - 1].ts;

    const inbox = await import("@/app/api/messaging/route");
    const list = await api<{ conversations: Array<{ id: string; channel: string; from_number: string; page_url: string | null; session_status: string }> }>(inbox.GET, "/api/messaging", { expect: 200 });
    const conv = list.body.conversations.find((c) => c.from_number === `web:${sessionId}`);
    expect(conv?.channel).toBe("webchat");
    expect(conv?.page_url).toBe(`${ORIGIN}/pricing`);
    expect(conv?.session_status).toBe("open");
  });

  it("holds the draft for approval when auto-reply is off; the visitor sees nothing until a human answers", async () => {
    await sql(`UPDATE user_integrations SET messaging_auto_reply = FALSE WHERE user_id = $1`, [org.dataId]);
    const route = await import("@/app/api/widget/chat/[siteId]/messages/route");
    const r = await api<{ reply: Msg | null; pendingHuman: boolean; messages: Msg[] }>(route.POST, `/api/widget/chat/${siteId}/messages`, {
      json: { text: "Can I get a discount?" },
      headers: { authorization: `Bearer ${token}` },
      params: { siteId },
      expect: 201,
    });
    expect(r.body.reply).toBeNull();
    expect(r.body.pendingHuman).toBe(true);
    expect(r.body.messages.filter((m) => m.role === "assistant")).toHaveLength(1); // only the first, auto-sent reply
    const approval = await sqlOne<{ id: string }>(`SELECT id FROM approvals WHERE user_id = $1 AND tool_name = 'messaging.reply' AND status = 'pending'`, [org.dataId]);
    expect(approval).toBeTruthy();

    const poll = await call<{ messages: Msg[]; status: string }>(route.GET, req(`/api/widget/chat/${siteId}/messages`, { query: { since: lastTs ?? undefined, wait: 0 }, headers: { authorization: `Bearer ${token}` } }), { siteId }, 200);
    expect(poll.body.messages.map((m) => m.role)).toEqual(["user"]);
    expect(poll.body.status).toBe("open");
    lastTs = poll.body.messages[0].ts;
  });

  it("handoff creates a contact, a lead and consent records, and marks the session handed off", async () => {
    const route = await import("@/app/api/widget/chat/[siteId]/handoff/route");
    await api(route.POST, `/api/widget/chat/${siteId}/handoff`, { json: { name: "No Contact" }, headers: { authorization: `Bearer ${token}` }, params: { siteId }, expect: 400 });
    const r = await api<{ ok: boolean; status: string; messages: Msg[] }>(route.POST, `/api/widget/chat/${siteId}/handoff`, {
      json: { name: "Dana Visitor", email: "dana@example.test", phone: "+15550100", consent: { marketing: true } },
      headers: { authorization: `Bearer ${token}`, origin: ORIGIN, "x-forwarded-for": "203.0.113.9" },
      params: { siteId },
      expect: 201,
    });
    expect(r.body.status).toBe("handed_off");
    expect(r.body.messages[r.body.messages.length - 1].content).toContain("Dana");
    lastTs = r.body.messages[r.body.messages.length - 1].ts;

    const s = await sqlOne<{ status: string; contact_id: string | null; lead_id: string | null }>(`SELECT status, contact_id, lead_id FROM chat_sessions WHERE id = $1`, [sessionId]);
    expect(s?.status).toBe("handed_off");
    expect(s?.contact_id).toBeTruthy();
    expect(s?.lead_id).toBeTruthy();
    const contact = await sqlOne<{ full_name: string; email: string }>(`SELECT full_name, email FROM crm_contacts WHERE id = $1 AND user_id = $2`, [s?.contact_id, org.dataId]);
    expect(contact?.email).toBe("dana@example.test");
    const lead = await sqlOne<{ data: string }>(`SELECT data FROM site_leads WHERE id = $1 AND user_id = $2`, [s?.lead_id, org.dataId]);
    expect(JSON.parse(lead?.data ?? "{}").source).toBe("webchat");
    const consent = await sql<{ purpose: string; status: string; subject_kind: string }>(`SELECT purpose, status, subject_kind FROM consent_records WHERE user_id = $1 AND subject_id = $2`, [org.dataId, s?.contact_id]);
    expect(consent.map((c) => c.purpose).sort()).toEqual(["marketing_email", "marketing_sms"]);
    expect(consent.every((c) => c.status === "granted")).toBe(true);
    await expectEvent(org.dataId, "webchat.handoff_requested", sessionId);

    // Handed off → the receptionist stays quiet on the next message.
    const msgs = await import("@/app/api/widget/chat/[siteId]/messages/route");
    const before = llm.calls;
    const m = await api<{ reply: Msg | null; pendingHuman: boolean }>(msgs.POST, `/api/widget/chat/${siteId}/messages`, { json: { text: "Thanks, waiting." }, headers: { authorization: `Bearer ${token}` }, params: { siteId }, expect: 201 });
    expect(m.body.reply).toBeNull();
    expect(m.body.pendingHuman).toBe(true);
    expect(llm.calls).toBe(before);
  });

  it("a staff reply through the messaging send path reaches the visitor on the next poll and via SSE", async () => {
    const inbox = await import("@/app/api/messaging/route");
    const conv = await sqlOne<{ id: string }>(`SELECT conversation_id AS id FROM chat_sessions WHERE id = $1`, [sessionId]);
    const sent = await api<{ ok: boolean; simulated: boolean }>(inbox.POST, "/api/messaging", { json: { conversationId: conv?.id, text: "Hi Dana, yes we ship to Canada — free over $50." }, expect: 200 });
    expect(sent.body.simulated).toBe(false);

    const route = await import("@/app/api/widget/chat/[siteId]/messages/route");
    const poll = await call<{ messages: Msg[]; status: string }>(route.GET, req(`/api/widget/chat/${siteId}/messages`, { query: { since: lastTs ?? undefined }, headers: { authorization: `Bearer ${token}` } }), { siteId }, 200);
    const texts = poll.body.messages.map((m) => m.content);
    expect(texts).toContain("Thanks, waiting.");
    expect(texts).toContain("Hi Dana, yes we ship to Canada — free over $50.");
    expect(poll.body.status).toBe("handed_off");

    const stream = await import("@/app/api/widget/chat/[siteId]/stream/route");
    // Not via call(): that reads the whole body, and an SSE stream stays open for 55s.
    const res = await stream.GET(req(`/api/widget/chat/${siteId}/stream`, { query: { token, since: lastTs ?? undefined } }), { params: Promise.resolve({ siteId }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body?.getReader();
    const first = await reader?.read();
    const second = await reader?.read();
    await reader?.cancel();
    const text = new TextDecoder().decode(first?.value) + new TextDecoder().decode(second?.value);
    expect(text).toContain(": connected");
    expect(text).toContain("event: messages");
    expect(text).toContain("free over $50");
  });

  it("staff can see sessions and the webchat tool reports counts; closing ends the session", async () => {
    const sessions = await import("@/app/api/webchat/sessions/route");
    const list = await api<{ sessions: Array<{ id: string; status: string }>; counts: { open: number; unanswered: number } }>(sessions.GET, "/api/webchat/sessions", { expect: 200 });
    expect(list.body.sessions.map((s) => s.id)).toContain(sessionId);
    expect(list.body.counts.open).toBeGreaterThanOrEqual(1);

    await import("@/lib/agents/tools/index");
    const { getTool } = await import("@/lib/agents/registry");
    const tool = getTool("webchat.sessions");
    expect(tool).toBeTruthy();
    const out = await tool!.run({ userId: org.dataId, runId: "t", agentId: null, autonomy: "auto" }, {});
    expect(out.ok).toBe(true);
    expect(out.summary).toMatch(/active web chat session/);

    const closed = await api<{ session: { status: string; closed_at: string | null } }>(sessions.PATCH, "/api/webchat/sessions", { method: "PATCH", json: { sessionId, action: "close" }, expect: 200 });
    expect(closed.body.session.status).toBe("closed");
    expect(closed.body.session.closed_at).toBeTruthy();

    const route = await import("@/app/api/widget/chat/[siteId]/messages/route");
    await api(route.POST, `/api/widget/chat/${siteId}/messages`, { json: { text: "hello?" }, headers: { authorization: `Bearer ${token}` }, params: { siteId }, expect: 410 });
  });

  it("rate limits session creation per IP", async () => {
    const route = await import("@/app/api/widget/chat/[siteId]/session/route");
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    let got429 = false;
    for (let i = 0; i < 22; i++) {
      const r = await api(route.POST, `/api/widget/chat/${siteId}/session`, { json: {}, headers: { "x-forwarded-for": ip }, params: { siteId } });
      if (r.status === 429) {
        got429 = true;
        expect(r.res.headers.get("retry-after")).toBeTruthy();
        break;
      }
      expect(r.status).toBe(201);
    }
    expect(got429).toBe(true);
  });
});
