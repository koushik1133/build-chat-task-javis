/**
 * Calendar sync + chat apps end to end (simulated calendar, local HTTP receiver):
 * connect → booking created → event pushed → reschedule updates → cancel deletes →
 * pull busy → slot disappears → ICS feed → chat integration delivery → test endpoint → 401/403.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { api, cleanupDataIds, createTestOrg, describeDb, expectEvent, setScope, sql, sqlOne, type TestOrg } from "./setup";

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));

interface PublicBooking { id: string; startsAt: string; endsAt: string; status: string }

describeDb("calsync + chat flow", () => {
  let org: TestOrg;
  let connId = "";
  let slots: string[] = [];
  let bookingA: PublicBooking;
  let busyStart = "";
  let server: Server;
  let received: Array<Record<string, unknown>> = [];
  let hookUrl = "";
  let integrationId = "";

  async function drainCal() {
    const { processCalendarEvents } = await import("@/lib/calsync/sync");
    let total = 0;
    for (let i = 0; i < 20; i++) {
      const r = await processCalendarEvents(500);
      total += r.pushed;
      if (r.scanned === 0) break;
    }
    return total;
  }
  async function drainChat() {
    const { processChatEvents } = await import("@/lib/chatops/process");
    let sent = 0;
    for (let i = 0; i < 20; i++) {
      const r = await processChatEvents(500);
      sent += r.sent;
      if (r.scanned === 0) break;
    }
    return sent;
  }
  async function bookSlot(startsAt: string, name: string): Promise<PublicBooking> {
    const pub = await import("@/app/api/book/[org]/[type]/route");
    const r = await api<{ booking: PublicBooking }>(pub.POST, `/api/book/${org.slug}/intro`, {
      json: { name, email: "guest@example.test", startsAt },
      params: { org: org.slug, type: "intro" },
      expect: 201,
    });
    return r.body.booking;
  }
  async function publicSlots(): Promise<string[]> {
    const pub = await import("@/app/api/book/[org]/[type]/route");
    const r = await api<{ slots: string[] }>(pub.GET, `/api/book/${org.slug}/intro`, { params: { org: org.slug, type: "intro" }, expect: 200 });
    return r.body.slots.map((s) => new Date(s).toISOString());
  }

  beforeAll(async () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY ||= "integration-test-encryption-key-0123456789";
    org = await createTestOrg("calsync");
    setScope(org);
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          received.push(JSON.parse(body) as Record<string, unknown>);
        } catch {
          /* ignore */
        }
        res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    hookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook/SECRETPATH1234`;
    // Prime both cursors so only events from this test are processed.
    const { ensureCalsyncCursor } = await import("@/lib/calsync/connections");
    await ensureCalsyncCursor();
    await drainCal();
    await drainChat();
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    if (connId) await sql(`DELETE FROM calsync_sim_events WHERE connection_id = $1`, [connId]).catch(() => undefined);
    await cleanupDataIds([org.dataId]);
  });

  it("sets availability and a booking type", async () => {
    const cal = await import("@/app/api/calendar/route");
    const g = await api<{ defaultCalendarId: string }>(cal.GET, "/api/calendar", { expect: 200 });
    const rules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_minute: 0, end_minute: 24 * 60 }));
    await api(cal.PATCH, "/api/calendar", { method: "PATCH", json: { timezone: "UTC", rules }, expect: 200 });
    expect(g.body.defaultCalendarId).toBeTruthy();
    const bt = await import("@/app/api/calendar/booking-types/route");
    await api(bt.POST, "/api/calendar/booking-types", { json: { name: "Intro", slug: "intro", duration_minutes: 30, min_notice_minutes: 0, max_days_ahead: 30 }, expect: 201 });
  });

  it("connects the simulated calendar", async () => {
    const connect = await import("@/app/api/calsync/connect/[provider]/route");
    const r = await api(connect.GET, "/api/calsync/connect/simulated", { params: { provider: "simulated" }, expect: [302, 307] });
    const loc = r.res.headers.get("location") ?? "";
    connId = new URL(loc).searchParams.get("connection") ?? "";
    expect(connId).toBeTruthy();
    const list = await import("@/app/api/calsync/connections/route");
    const g = await api<{ connections: Array<{ id: string; provider: string; settings: { push_bookings: boolean } }>; providers: Array<{ id: string }> }>(list.GET, "/api/calsync/connections", { expect: 200 });
    expect(g.body.connections.map((c) => c.id)).toContain(connId);
    expect(JSON.stringify(g.body)).not.toContain('"auth"');
    expect(g.body.providers.map((p) => p.id)).toEqual(expect.arrayContaining(["google", "outlook", "simulated"]));
  });

  it("pushes a new booking, updates it on reschedule (idempotent replays), and deletes it on cancel", async () => {
    slots = await publicSlots();
    const tomorrow = Date.now() + 86_400_000;
    const future = slots.filter((s) => new Date(s).getTime() > tomorrow);
    bookingA = await bookSlot(future[2], "Grace Hopper");
    expect(await drainCal()).toBe(1);
    const sim = await sql<{ id: string; title: string; starts_at: string }>(`SELECT id, title, starts_at FROM calsync_sim_events WHERE connection_id = $1`, [connId]);
    expect(sim).toHaveLength(1);
    expect(sim[0].title).toBe("Appointment: Grace");
    const link = await sqlOne<{ external_event_id: string }>(`SELECT external_event_id FROM calendar_event_links WHERE connection_id = $1 AND booking_id = $2`, [connId, bookingA.id]);
    expect(link?.external_event_id).toBe(sim[0].id);

    // Replaying the processor with nothing new does nothing.
    expect(await drainCal()).toBe(0);
    expect(await sql(`SELECT 1 FROM calsync_sim_events WHERE connection_id = $1`, [connId])).toHaveLength(1);

    // Reschedule: same event, new time.
    const newStart = future[5];
    const newEnd = new Date(new Date(newStart).getTime() + 30 * 60_000).toISOString();
    await sql(`UPDATE bookings SET starts_at = $3, ends_at = $4 WHERE id = $1 AND user_id = $2`, [bookingA.id, org.dataId, newStart, newEnd]);
    const { emitEvent } = await import("@/lib/events/bus");
    await emitEvent(org.dataId, { type: "booking.rescheduled", entity: "booking", entityId: bookingA.id, data: { name: "Grace Hopper", from: bookingA.startsAt, to: newStart } });
    expect(await drainCal()).toBe(1);
    const after = await sql<{ id: string; starts_at: string }>(`SELECT id, starts_at FROM calsync_sim_events WHERE connection_id = $1`, [connId]);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(sim[0].id);
    expect(new Date(after[0].starts_at).toISOString()).toBe(newStart);
    expect(await sql(`SELECT 1 FROM calendar_event_links WHERE connection_id = $1`, [connId])).toHaveLength(1);

    // Cancel deletes the external event and the link.
    const { cancelBooking } = await import("@/lib/calendar/booking");
    await cancelBooking(org.dataId, bookingA.id, "test");
    expect(await drainCal()).toBe(1);
    expect(await sql(`SELECT 1 FROM calsync_sim_events WHERE connection_id = $1`, [connId])).toHaveLength(0);
    expect(await sql(`SELECT 1 FROM calendar_event_links WHERE connection_id = $1`, [connId])).toHaveLength(0);
  });

  it("pulls external busy time (times + hash only) and removes the slot", async () => {
    const future = (await publicSlots()).filter((s) => new Date(s).getTime() > Date.now() + 86_400_000);
    busyStart = future[4];
    expect(future).toContain(busyStart);
    const { addSimulatedExternalEvent } = await import("@/lib/calsync/providers/simulated");
    await addSimulatedExternalEvent(connId, { title: "Dentist (private)", startsAt: busyStart, endsAt: new Date(new Date(busyStart).getTime() + 30 * 60_000).toISOString() });
    const conn = await import("@/app/api/calsync/connections/[id]/route");
    const sync = await api<{ ok: boolean; busy: number }>(conn.POST, `/api/calsync/connections/${connId}`, { method: "POST", params: { id: connId }, expect: 200 });
    expect(sync.body.busy).toBe(1);
    const rows = await sql<Record<string, unknown>>(`SELECT * FROM external_busy WHERE connection_id = $1`, [connId]);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("Dentist");
    expect(String(rows[0].summary_hash)).toMatch(/^[0-9a-f]{16}$/);
    expect(await publicSlots()).not.toContain(new Date(busyStart).toISOString());

    // Public booking of that time is now refused.
    const pub = await import("@/app/api/book/[org]/[type]/route");
    await api(pub.POST, `/api/book/${org.slug}/intro`, { json: { name: "Late", email: "l@example.test", startsAt: busyStart }, params: { org: org.slug, type: "intro" }, expect: 409 });

    // Turning pull_busy off clears the blocks and frees the slot.
    await api(conn.PATCH, `/api/calsync/connections/${connId}`, { method: "PATCH", json: { settings: { pull_busy: false } }, params: { id: connId }, expect: 200 });
    expect(await publicSlots()).toContain(new Date(busyStart).toISOString());
  });

  it("serves a private ICS feed with first names only", async () => {
    const free = (await publicSlots()).filter((s) => new Date(s).getTime() > Date.now() + 86_400_000);
    await bookSlot(free[1], "Katherine Johnson");
    const feed = await import("@/app/api/calendar/feed/route");
    const issued = await api<{ url: string }>(feed.POST, "/api/calendar/feed", { json: {}, expect: 200 });
    const token = issued.body.url.split("/").pop() ?? "";
    const tokenRoute = await import("@/app/api/calendar/feed/[token]/route");
    const r = await api<string>(tokenRoute.GET, `/api/calendar/feed/${token}`, { params: { token }, expect: 200 });
    expect(r.res.headers.get("content-type")).toContain("text/calendar");
    expect(r.body).toContain("BEGIN:VCALENDAR");
    expect(r.body).toContain("SUMMARY:Appointment: Katherine");
    expect(r.body).not.toContain("Johnson");
    expect(r.body).not.toContain("guest@example.test");
    await api(tokenRoute.GET, "/api/calendar/feed/bad", { params: { token: "bad" }, expect: 404 });
    // Rotating revokes the old link.
    await api(feed.POST, "/api/calendar/feed", { json: { rotate: true }, expect: 200 });
    await api(tokenRoute.GET, `/api/calendar/feed/${token}`, { params: { token }, expect: 404 });
  });

  it("rejects bad chat webhook hosts, then creates a generic webhook integration (masked)", async () => {
    const route = await import("@/app/api/chat-integrations/route");
    await api(route.POST, "/api/chat-integrations", { json: { provider: "slack", name: "Bad", webhook_url: "https://evil.example.com/services/x/y/z", events: ["booking.created"] }, expect: 400 });
    await api(route.POST, "/api/chat-integrations", { json: { provider: "webhook", name: "Bad", webhook_url: "http://169.254.169.254/x", events: [] }, expect: 400 });
    const created = await api<{ integration: { id: string; webhook_url_masked: string } }>(route.POST, "/api/chat-integrations", {
      json: { provider: "webhook", name: "Ops hook", webhook_url: hookUrl, channel_label: "#ops", events: ["booking.*"] },
      expect: 201,
    });
    integrationId = created.body.integration.id;
    expect(created.body.integration.webhook_url_masked).not.toContain("SECRETPATH");
    const stored = await sqlOne<{ webhook_url_enc: string }>(`SELECT webhook_url_enc FROM chat_integrations WHERE id = $1`, [integrationId]);
    expect(stored?.webhook_url_enc).not.toContain("127.0.0.1");
    const list = await api<{ integrations: Array<{ id: string }> }>(route.GET, "/api/chat-integrations", { expect: 200 });
    expect(list.body.integrations.map((i) => i.id)).toContain(integrationId);
  });

  it("delivers matching events once and the test endpoint posts a message", async () => {
    received = [];
    await drainChat(); // flush any earlier events that predate the integration's existence in this run
    received = [];
    const free = (await publicSlots()).filter((s) => new Date(s).getTime() > Date.now() + 86_400_000);
    const b = await bookSlot(free[7], "Ada Lovelace");
    expect(await drainChat()).toBeGreaterThanOrEqual(1);
    const hit = received.find((m) => m.event === "booking.created");
    expect(hit).toBeTruthy();
    expect(String(hit?.title)).toContain("Booking created");
    expect(await drainChat()).toBe(0); // idempotent
    expect(received.filter((m) => m.event === "booking.created")).toHaveLength(1);
    expect(b.id).toBeTruthy();

    const test = await import("@/app/api/chat-integrations/[id]/test/route");
    received = [];
    const t = await api<{ ok: boolean }>(test.POST, `/api/chat-integrations/${integrationId}/test`, { method: "POST", params: { id: integrationId }, expect: 200 });
    expect(t.body.ok).toBe(true);
    expect(received[0]?.title).toBe("KernelHub test message");
    const row = await sqlOne<{ last_status: string }>(`SELECT last_status FROM chat_integrations WHERE id = $1`, [integrationId]);
    expect(row?.last_status).toBe("ok");
  });

  it("records a failed delivery and emits chat.delivery_failed", async () => {
    const one = await import("@/app/api/chat-integrations/[id]/route");
    await api(one.PATCH, `/api/chat-integrations/${integrationId}`, { method: "PATCH", json: { webhook_url: "http://127.0.0.1:9/dead" }, params: { id: integrationId }, expect: 200 });
    const test = await import("@/app/api/chat-integrations/[id]/test/route");
    await api(test.POST, `/api/chat-integrations/${integrationId}/test`, { method: "POST", params: { id: integrationId }, expect: 502 });
    await expectEvent(org.dataId, "chat.delivery_failed", integrationId);
    await api(test.POST, "/api/chat-integrations/nope/test", { method: "POST", params: { id: "nope" }, expect: 404 });
  });

  it("enforces 401 without a session and 403 for viewers on writes", async () => {
    const list = await import("@/app/api/calsync/connections/route");
    const chat = await import("@/app/api/chat-integrations/route");
    setScope(org, { role: "viewer" });
    await api(chat.POST, "/api/chat-integrations", { json: { provider: "webhook", name: "x", webhook_url: hookUrl, events: [] }, expect: 403 });
    await api(list.DELETE, `/api/calsync/connections?id=${connId}`, { method: "DELETE", expect: 403 });
    setScope(null);
    await api(list.GET, "/api/calsync/connections", { expect: 401 });
    await api(chat.GET, "/api/chat-integrations", { expect: 401 });
    setScope(org);
    await api(list.DELETE, `/api/calsync/connections?id=${connId}`, { method: "DELETE", expect: 200 });
    expect(await sql(`SELECT 1 FROM calsync_sim_events WHERE connection_id = $1`, [connId])).toHaveLength(0);
  });
});
