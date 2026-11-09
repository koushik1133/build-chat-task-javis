/**
 * Portal 2.0 end to end: contact + token → data shape (no internal fields) →
 * slots → reschedule → clash 409 → change window → cancel → messages in/out →
 * staff reply → request-link generic 202 → org/contact isolation.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { api, cleanupDataIds, createTestOrg, describeDb, eventsFor, expectEvent, setScope, sql, sqlOne, waitForRows, type TestOrg } from "./setup";

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));

interface PortalBody {
  contact: { id: string; name: string };
  projects: Array<{ id: string; name: string; percent: number }>;
  upcomingBookings: Array<{ id: string; canChange: boolean; hasType: boolean }>;
  bookings: Array<{ id: string }>;
  orders: unknown[];
  documents: unknown[];
  unreadMessages: number;
  changeWindowHours: number;
  invoices: unknown[];
}

describeDb("portal flow", () => {
  let A: TestOrg;
  let B: TestOrg;
  let typeId = "";
  let contactA = "";
  let contactB = "";
  let tokenA = "";
  let tokenB = "";
  let bookingId = "";
  let otherBookingId = "";
  let slots: string[] = [];

  const ctx = (token: string) => ({ token });

  beforeAll(async () => {
    A = await createTestOrg("portalA");
    B = await createTestOrg("portalB");
    setScope(A);
    const cal = await import("@/app/api/calendar/route");
    const g = await api<{ defaultCalendarId: string }>(cal.GET, "/api/calendar", { expect: 200 });
    const rules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_minute: 0, end_minute: 24 * 60 }));
    await api(cal.PATCH, "/api/calendar", { method: "PATCH", json: { timezone: "UTC", rules }, expect: 200 });
    const bt = await import("@/app/api/calendar/booking-types/route");
    const t = await api<{ type: { id: string } }>(bt.POST, "/api/calendar/booking-types", { json: { name: "Intro", slug: "intro", duration_minutes: 30, min_notice_minutes: 0, max_days_ahead: 30 }, expect: 201 });
    typeId = t.body.type.id;
    void g;

    contactA = randomUUID();
    contactB = randomUUID();
    await sql(`INSERT INTO crm_contacts (id, user_id, full_name, email, notes) VALUES ($1, $2, 'Alice A', 'alice@example.test', 'INTERNAL SECRET NOTE')`, [contactA, A.dataId]);
    await sql(`INSERT INTO crm_contacts (id, user_id, full_name, email) VALUES ($1, $2, 'Bob B', 'bob@example.test')`, [contactB, B.dataId]);
    const { issueShareToken } = await import("@/lib/share-tokens");
    tokenA = (await issueShareToken(A.dataId, "portal", contactA, 14)).token;
    tokenB = (await issueShareToken(B.dataId, "portal", contactB, 14)).token;

    // A project for Alice with a budget that must never reach the portal.
    const pid = randomUUID();
    await sql(`INSERT INTO projects (id, user_id, name, contact_id, status, budget_minor, due_on) VALUES ($1, $2, 'Website', $3, 'active', 987654, '2027-01-01')`, [pid, A.dataId, contactA]);
    await sql(`INSERT INTO project_milestones (id, user_id, project_id, name, status, sort) VALUES ($1, $2, $3, 'Design', 'open', 0)`, [randomUUID(), A.dataId, pid]);

    // Open slots a few days out.
    const { getBookingType, availableSlots } = await import("@/lib/calendar/booking");
    const type = await getBookingType(A.dataId, typeId);
    const res = await availableSlots(type!, new Date(Date.now() + 3 * 86_400_000), new Date(Date.now() + 8 * 86_400_000));
    slots = res.slots;
    const { createBooking } = await import("@/lib/calendar/booking");
    const b1 = await createBooking(A.dataId, { bookingTypeId: typeId, contactId: contactA, name: "Alice A", email: "alice@example.test", startsAt: slots[0], source: "portal" });
    const b2 = await createBooking(A.dataId, { bookingTypeId: typeId, name: "Someone", email: "s@example.test", startsAt: slots[10], source: "public" });
    bookingId = b1.booking.id;
    otherBookingId = b2.booking.id;
  });

  afterAll(async () => {
    await cleanupDataIds([A.dataId, B.dataId]);
  });

  it("portal data has the v2 shape and no internal fields", async () => {
    const route = await import("@/app/api/p/portal/[token]/route");
    const r = await api<PortalBody>(route.GET, `/api/p/portal/${tokenA}`, { params: ctx(tokenA), expect: 200 });
    expect(r.body.contact.name).toBe("Alice A");
    expect(r.body.projects).toHaveLength(1);
    expect(r.body.projects[0].name).toBe("Website");
    expect(r.body.upcomingBookings.map((b) => b.id)).toContain(bookingId);
    expect(r.body.upcomingBookings.find((b) => b.id === bookingId)?.canChange).toBe(true);
    expect(r.body.changeWindowHours).toBe(24);
    expect(Array.isArray(r.body.orders)).toBe(true);
    expect(Array.isArray(r.body.documents)).toBe(true);
    const text = JSON.stringify(r.body);
    expect(text).not.toContain("INTERNAL SECRET NOTE");
    expect(text).not.toContain("987654");
    expect(text).not.toContain("budget_minor");
    expect(text).not.toContain(A.dataId);
    const { findForbiddenKey } = await import("@/lib/portal-rules");
    expect(findForbiddenKey(r.body)).toBeNull();
  });

  it("lists slots for the same booking type and rejects other contacts' bookings", async () => {
    const route = await import("@/app/api/p/portal/[token]/bookings/route");
    const r = await api<{ slots: string[]; durationMinutes: number }>(route.GET, `/api/p/portal/${tokenA}/bookings`, { params: ctx(tokenA), query: { bookingId }, expect: 200 });
    expect(r.body.durationMinutes).toBe(30);
    expect(r.body.slots.length).toBeGreaterThan(5);
    // Not Alice's booking.
    await api(route.GET, `/api/p/portal/${tokenA}/bookings`, { params: ctx(tokenA), query: { bookingId: otherBookingId }, expect: 404 });
    // Org B's token cannot touch org A's booking.
    await api(route.GET, `/api/p/portal/${tokenB}/bookings`, { params: ctx(tokenB), query: { bookingId }, expect: 404 });
    await api(route.POST, `/api/p/portal/${tokenB}/bookings`, { method: "POST", params: ctx(tokenB), json: { bookingId, startsAt: slots[20] }, expect: 404 });
  });

  it("reschedules to a free slot; clash with another booking → 409", async () => {
    const route = await import("@/app/api/p/portal/[token]/bookings/route");
    const ok = await api<{ ok: boolean; booking: { startsAt: string } }>(route.POST, `/api/p/portal/${tokenA}/bookings`, { method: "POST", params: ctx(tokenA), json: { bookingId, startsAt: slots[5] }, expect: 200 });
    expect(new Date(ok.body.booking.startsAt).toISOString()).toBe(new Date(slots[5]).toISOString());
    await expectEvent(A.dataId, "booking.rescheduled", bookingId);
    const staffNote = await waitForRows<{ id: string }>(`SELECT id FROM notification_outbox WHERE user_id = $1 AND channel = 'in_app' AND data LIKE '%booking.rescheduled%'`, [A.dataId]);
    expect(staffNote.length).toBeGreaterThan(0);
    // slots[10] is held by the other booking.
    await api(route.POST, `/api/p/portal/${tokenA}/bookings`, { method: "POST", params: ctx(tokenA), json: { bookingId, startsAt: slots[10] }, expect: 409 });
    // Not an open slot (off-grid time) → also rejected as unavailable.
    const off = new Date(new Date(slots[6]).getTime() + 7 * 60_000).toISOString();
    await api(route.POST, `/api/p/portal/${tokenA}/bookings`, { method: "POST", params: ctx(tokenA), json: { bookingId, startsAt: off }, expect: 409 });
    await api(route.POST, `/api/p/portal/${tokenA}/bookings`, { method: "POST", params: ctx(tokenA), json: { bookingId, bogus: 1 }, expect: 400 });
  });

  it("enforces the change window for reschedule and cancel (org setting)", async () => {
    const { createBooking } = await import("@/lib/calendar/booking");
    const soon = await createBooking(A.dataId, { bookingTypeId: typeId, contactId: contactA, name: "Alice A", email: "alice@example.test", startsAt: new Date(Date.now() + 2 * 3_600_000), source: "manual", ignoreRules: true });
    const route = await import("@/app/api/p/portal/[token]/bookings/route");
    const cancel = await import("@/app/api/p/portal/[token]/bookings/cancel/route");
    const r = await api<{ error: string }>(route.POST, `/api/p/portal/${tokenA}/bookings`, { method: "POST", params: ctx(tokenA), json: { bookingId: soon.booking.id, startsAt: slots[30] }, expect: 403 });
    expect(r.body.error).toBe("outside_change_window");
    await api(cancel.POST, `/api/p/portal/${tokenA}/bookings/cancel`, { method: "POST", params: ctx(tokenA), json: { bookingId: soon.booking.id }, expect: 403 });
    // Lower the window to 1 hour via org settings → now allowed (2h away).
    await sql(`UPDATE organizations SET settings = $2 WHERE owner_user_id = $1`, [A.dataId, JSON.stringify({ booking_reschedule_hours: 1 })]);
    await api(cancel.POST, `/api/p/portal/${tokenA}/bookings/cancel`, { method: "POST", params: ctx(tokenA), json: { bookingId: soon.booking.id }, expect: 200 });
    await expectEvent(A.dataId, "booking.cancelled", soon.booking.id);
    await sql(`UPDATE organizations SET settings = NULL WHERE owner_user_id = $1`, [A.dataId]);
  });

  it("cancels an upcoming booking outside the window", async () => {
    const cancel = await import("@/app/api/p/portal/[token]/bookings/cancel/route");
    await api(cancel.POST, `/api/p/portal/${tokenA}/bookings/cancel`, { method: "POST", params: ctx(tokenA), json: { bookingId }, expect: 200 });
    const row = await sqlOne<{ status: string }>(`SELECT status FROM bookings WHERE id = $1`, [bookingId]);
    expect(row?.status).toBe("cancelled");
    await api(cancel.POST, `/api/p/portal/${tokenA}/bookings/cancel`, { method: "POST", params: ctx(tokenA), json: { bookingId: otherBookingId }, expect: 404 });
  });

  it("messages: customer → staff → customer, with validation and isolation", async () => {
    const msgs = await import("@/app/api/p/portal/[token]/messages/route");
    await api(msgs.GET, `/api/p/portal/badtoken/messages`, { params: ctx("badtoken"), expect: 404 });
    await api(msgs.POST, `/api/p/portal/${tokenA}/messages`, { method: "POST", params: ctx(tokenA), json: { body: "x".repeat(2500) }, expect: 400 });
    await api(msgs.POST, `/api/p/portal/${tokenA}/messages`, { method: "POST", params: ctx(tokenA), json: { body: "   " }, expect: 400 });
    const sent = await api<{ message: { id: string; direction: string } }>(msgs.POST, `/api/p/portal/${tokenA}/messages`, { method: "POST", params: ctx(tokenA), json: { body: "Can we talk about the invoice?" }, expect: 201 });
    expect(sent.body.message.direction).toBe("in");
    await expectEvent(A.dataId, "portal.message_received", sent.body.message.id);
    const note = await waitForRows<{ id: string }>(`SELECT id FROM notification_outbox WHERE user_id = $1 AND channel = 'in_app' AND data LIKE '%portal.message_received%'`, [A.dataId]);
    expect(note.length).toBe(1);

    // Staff view + reply.
    setScope(A);
    const staff = await import("@/app/api/portal-messages/route");
    const threads = await api<{ threads: Array<{ contact_id: string; unread: number }> }>(staff.GET, "/api/portal-messages", { expect: 200 });
    expect(threads.body.threads.find((t) => t.contact_id === contactA)?.unread).toBe(1);
    const reply = await api<{ message: { direction: string } }>(staff.POST, "/api/portal-messages", { method: "POST", json: { contact_id: contactA, body: "Sure — calling you today." }, expect: 201 });
    expect(reply.body.message.direction).toBe("out");
    await api(staff.PATCH, "/api/portal-messages", { method: "PATCH", json: { contact_id: contactA }, expect: 200 });
    const mail = await waitForRows<{ body: string }>(`SELECT body FROM notification_outbox WHERE user_id = $1 AND channel = 'email' AND recipient = 'alice@example.test' AND data LIKE '%portal.message_out%'`, [A.dataId]);
    expect(mail[0].body).toContain("/p/c/");
    // Viewer role cannot reply.
    setScope(A, { role: "viewer" });
    await api(staff.POST, "/api/portal-messages", { method: "POST", json: { contact_id: contactA, body: "nope" }, expect: 403 });
    setScope(A);

    // Customer sees both, with unread count then cleared.
    const route = await import("@/app/api/p/portal/[token]/route");
    const before = await api<PortalBody>(route.GET, `/api/p/portal/${tokenA}`, { params: ctx(tokenA), expect: 200 });
    expect(before.body.unreadMessages).toBe(1);
    const thread = await api<{ messages: Array<{ direction: string; body: string }> }>(msgs.GET, `/api/p/portal/${tokenA}/messages`, { params: ctx(tokenA), query: { markRead: "1" }, expect: 200 });
    expect(thread.body.messages.map((m) => m.direction)).toEqual(["in", "out"]);
    expect(JSON.stringify(thread.body)).not.toContain(A.dataId);
    const after = await api<PortalBody>(route.GET, `/api/p/portal/${tokenA}`, { params: ctx(tokenA), expect: 200 });
    expect(after.body.unreadMessages).toBe(0);

    // Isolation: Bob sees nothing of Alice's thread.
    const bob = await api<{ messages: unknown[] }>(msgs.GET, `/api/p/portal/${tokenB}/messages`, { params: ctx(tokenB), expect: 200 });
    expect(bob.body.messages).toHaveLength(0);
    const bobData = await api<PortalBody>(route.GET, `/api/p/portal/${tokenB}`, { params: ctx(tokenB), expect: 200 });
    expect(bobData.body.contact.id).toBe(contactB);
    expect(bobData.body.projects).toHaveLength(0);
    expect(JSON.stringify(bobData.body)).not.toContain("Alice");
    expect((await eventsFor(B.dataId, "portal.message_received")).length).toBe(0);
  });

  it("message rate limit returns 429", async () => {
    const msgs = await import("@/app/api/p/portal/[token]/messages/route");
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) statuses.push((await api(msgs.POST, `/api/p/portal/${tokenB}/messages`, { method: "POST", params: ctx(tokenB), json: { body: `hi ${i}` } })).status);
    expect(statuses).toContain(429);
    expect(statuses.filter((s) => s === 201).length).toBeLessThanOrEqual(10);
  });

  it("request-link: generic 202 for known and unknown, mail only for the known contact", async () => {
    const route = await import("@/app/api/p/portal/request-link/route");
    const known = await api<{ message: string }>(route.POST, "/api/p/portal/request-link", { method: "POST", headers: { "x-forwarded-for": "5.5.5.1" }, json: { org: A.slug, email: "ALICE@example.test" }, expect: 202 });
    const unknownEmail = await api<{ message: string }>(route.POST, "/api/p/portal/request-link", { method: "POST", headers: { "x-forwarded-for": "5.5.5.2" }, json: { org: A.slug, email: "ghost@example.test" }, expect: 202 });
    const unknownOrg = await api<{ message: string }>(route.POST, "/api/p/portal/request-link", { method: "POST", headers: { "x-forwarded-for": "5.5.5.3" }, json: { org: "no-such-org", email: "alice@example.test" }, expect: 202 });
    expect(known.body).toEqual(unknownEmail.body);
    expect(known.body).toEqual(unknownOrg.body);
    const sentKnown = await waitForRows<{ body: string }>(`SELECT body FROM notification_outbox WHERE user_id = $1 AND recipient = 'alice@example.test' AND data LIKE '%portal.link%'`, [A.dataId]);
    const tok = sentKnown[0].body.match(/\/p\/c\/([A-Za-z0-9_-]+)/)?.[1] ?? "";
    expect(tok.length).toBeGreaterThan(20);
    const ghost = await sql(`SELECT id FROM notification_outbox WHERE recipient = 'ghost@example.test'`);
    expect(ghost).toHaveLength(0);
    // The emailed link works and resolves to Alice only.
    const portal = await import("@/app/api/p/portal/[token]/route");
    const d = await api<PortalBody>(portal.GET, `/api/p/portal/${tok}`, { params: ctx(tok), expect: 200 });
    expect(d.body.contact.id).toBe(contactA);
  });
});
