/**
 * Booking end-to-end: availability → booking type → public slots → book →
 * double-book 409 → cancel via token → portal listing → crew link day view
 * → clock in / out writes time_entries.
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { api, cleanupDataIds, createTestOrg, describeDb, eventsFor, expectEvent, setScope, sql, sqlOne, waitForRows, type TestOrg } from "./setup";

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));

interface BookingType { id: string; slug: string; name: string; duration_minutes: number }
interface PublicBooking { id: string; startsAt: string; endsAt: string; status: string }

describeDb("booking flow", () => {
  let org: TestOrg;
  let type: BookingType;
  let slot: string;
  let booking: PublicBooking;
  let cancelToken: string;
  let contactId: string;
  let crewToken: string;
  const customerEmail = "guest@example.test";

  beforeAll(async () => {
    org = await createTestOrg("booking");
    setScope(org);
  });
  afterAll(async () => {
    await cleanupDataIds([org.dataId]);
  });

  it("sets 24x7 availability on the default calendar", async () => {
    const cal = await import("@/app/api/calendar/route");
    const g = await api<{ calendars: Array<{ id: string; rules: unknown[] }>; defaultCalendarId: string; canEdit: boolean }>(cal.GET, "/api/calendar", { expect: 200 });
    expect(g.body.calendars).toHaveLength(1);
    expect(g.body.calendars[0].rules).toHaveLength(5); // default Mon–Fri 9–17
    expect(g.body.canEdit).toBe(true);
    const rules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_minute: 0, end_minute: 24 * 60 }));
    const p = await api<{ ok: boolean; rules: unknown[] }>(cal.PATCH, "/api/calendar", { method: "PATCH", json: { timezone: "UTC", rules }, expect: 200 });
    expect(p.body.rules).toHaveLength(7);
    const dbRules = await sql(`SELECT id FROM availability_rules WHERE calendar_id = $1`, [g.body.defaultCalendarId]);
    expect(dbRules).toHaveLength(7);
  });

  it("creates a booking type (and rejects a duplicate slug)", async () => {
    const bt = await import("@/app/api/calendar/booking-types/route");
    const r = await api<{ type: BookingType; publicPath: string }>(bt.POST, "/api/calendar/booking-types", {
      json: { name: "Intro call", slug: "intro", duration_minutes: 30, min_notice_minutes: 0, max_days_ahead: 30 },
      expect: 201,
    });
    type = r.body.type;
    expect(type.slug).toBe("intro");
    expect(r.body.publicPath).toBe(`/book/${org.slug}/intro`);
    await api(bt.POST, "/api/calendar/booking-types", { json: { name: "Intro again", slug: "intro" }, expect: 409 });
    const list = await api<{ types: BookingType[] }>(bt.GET, "/api/calendar/booking-types", { expect: 200 });
    expect(list.body.types.map((t) => t.id)).toContain(type.id);
  });

  it("public slots endpoint lists open slots", async () => {
    const pub = await import("@/app/api/book/[org]/[type]/route");
    const r = await api<{ org: { slug: string }; type: { slug: string; durationMinutes: number }; slots: string[]; byDay: Record<string, string[]> }>(
      pub.GET, `/api/book/${org.slug}/intro`, { params: { org: org.slug, type: "intro" }, expect: 200 }
    );
    expect(r.body.org.slug).toBe(org.slug);
    expect(r.body.type.durationMinutes).toBe(30);
    expect(r.body.slots.length).toBeGreaterThan(10);
    // Pick a slot comfortably in the future (tomorrow+) so it is stable through the test.
    const tomorrow = Date.now() + 86_400_000;
    slot = r.body.slots.find((s) => new Date(s).getTime() > tomorrow) ?? r.body.slots[r.body.slots.length - 1];
    expect(Object.keys(r.body.byDay).length).toBeGreaterThan(0);
    await api(pub.GET, `/api/book/${org.slug}/nope`, { params: { org: org.slug, type: "nope" }, expect: 404 });
    await api(pub.GET, `/api/book/no-such-org/intro`, { params: { org: "no-such-org", type: "intro" }, expect: 404 });
  });

  it("books the slot, upserts a contact, emits booking.created; same slot → 409", async () => {
    const pub = await import("@/app/api/book/[org]/[type]/route");
    const r = await api<{ booking: PublicBooking; cancelPath: string }>(pub.POST, `/api/book/${org.slug}/intro`, {
      json: { name: "Guest Person", email: customerEmail, phone: "+15550001111", startsAt: slot, notes: "Looking forward" },
      params: { org: org.slug, type: "intro" },
      expect: 201,
    });
    booking = r.body.booking;
    expect(booking.status).toBe("confirmed");
    expect(new Date(booking.startsAt).toISOString()).toBe(new Date(slot).toISOString());
    expect(new Date(booking.endsAt).getTime() - new Date(booking.startsAt).getTime()).toBe(30 * 60_000);
    cancelToken = r.body.cancelPath.split("/").pop() ?? "";
    expect(cancelToken.length).toBeGreaterThan(20);

    const row = await sqlOne<{ contact_id: string | null; source: string; booking_type_id: string; cancel_token_hash: string }>(
      `SELECT contact_id, source, booking_type_id, cancel_token_hash FROM bookings WHERE id = $1 AND user_id = $2`, [booking.id, org.dataId]
    );
    expect(row?.source).toBe("public");
    expect(row?.booking_type_id).toBe(type.id);
    expect(row?.contact_id).toBeTruthy();
    expect(row?.cancel_token_hash).toMatch(/^[0-9a-f]{64}$/);
    contactId = row?.contact_id as string;
    const contact = await sqlOne<{ email: string; tags: string }>(`SELECT email, tags FROM crm_contacts WHERE id = $1`, [contactId]);
    expect(contact?.email).toBe(customerEmail);
    expect(contact?.tags).toContain("booking");
    await expectEvent(org.dataId, "booking.created", booking.id);
    await expectEvent(org.dataId, "crm.contact.created", contactId);
    const mail = await sqlOne<{ body: string }>(`SELECT body FROM notification_outbox WHERE user_id = $1 AND recipient = $2 ORDER BY created_at DESC LIMIT 1`, [org.dataId, customerEmail]);
    expect(mail?.body).toContain(`/book/cancel/${cancelToken}`);

    // Double booking the same slot is rejected and the slot disappears from the public list.
    const dup = await api<{ error: string }>(pub.POST, `/api/book/${org.slug}/intro`, {
      json: { name: "Someone Else", email: "other@example.test", startsAt: slot },
      params: { org: org.slug, type: "intro" },
      expect: 409,
    });
    expect(dup.body.error).toBe("conflict");
    const slots = await api<{ slots: string[] }>(pub.GET, `/api/book/${org.slug}/intro`, { params: { org: org.slug, type: "intro" }, expect: 200 });
    expect(slots.body.slots.map((s) => new Date(s).toISOString())).not.toContain(new Date(slot).toISOString());
    // validation
    await api(pub.POST, `/api/book/${org.slug}/intro`, { json: { name: "", email: customerEmail, startsAt: slot }, params: { org: org.slug, type: "intro" }, expect: 400 });
    await api(pub.POST, `/api/book/${org.slug}/intro`, { json: { name: "X", email: "not-an-email", startsAt: slot }, params: { org: org.slug, type: "intro" }, expect: 400 });
  });

  it("marketing consent from the public form binds to the booking for an existing contact and to the contact only when the booking created it", async () => {
    const pub = await import("@/app/api/book/[org]/[type]/route");
    const slots = await api<{ slots: string[] }>(pub.GET, `/api/book/${org.slug}/intro`, { params: { org: org.slug, type: "intro" }, expect: 200 });
    const [slotA, slotB] = slots.body.slots.slice(-2);
    // Same email as the existing contact: the unverified form must not flip that contact's consent.
    const r1 = await api<{ booking: PublicBooking }>(pub.POST, `/api/book/${org.slug}/intro`, {
      json: { name: "Guest Person", email: customerEmail, startsAt: slotA, consent: { marketing: true } },
      params: { org: org.slug, type: "intro" },
      expect: 201,
    });
    const onBooking = await waitForRows<{ subject_kind: string; purpose: string; status: string }>(`SELECT subject_kind, purpose, status FROM consent_records WHERE user_id = $1 AND subject_id = $2`, [org.dataId, r1.body.booking.id], 2);
    expect(onBooking.map((c) => c.purpose).sort()).toEqual(["marketing_email", "marketing_sms"]);
    expect(onBooking.every((c) => c.subject_kind === "booking" && c.status === "granted")).toBe(true);
    const onExisting = await sql(`SELECT 1 FROM consent_records WHERE user_id = $1 AND subject_kind = 'contact' AND subject_id = $2`, [org.dataId, contactId]);
    expect(onExisting).toHaveLength(0);
    // A brand-new email creates the contact, so consent lands on that contact.
    const r2 = await api<{ booking: PublicBooking }>(pub.POST, `/api/book/${org.slug}/intro`, {
      json: { name: "New Person", email: "new-person@example.test", startsAt: slotB, consent: { marketing: false } },
      params: { org: org.slug, type: "intro" },
      expect: 201,
    });
    const newContact = await sqlOne<{ contact_id: string }>(`SELECT contact_id FROM bookings WHERE id = $1 AND user_id = $2`, [r2.body.booking.id, org.dataId]);
    const onContact = await waitForRows<{ subject_kind: string; status: string }>(`SELECT subject_kind, status FROM consent_records WHERE user_id = $1 AND subject_id = $2`, [org.dataId, newContact!.contact_id], 2);
    expect(onContact.every((c) => c.subject_kind === "contact" && c.status === "withdrawn")).toBe(true);
    await sql(`UPDATE bookings SET status = 'cancelled' WHERE id = ANY($1) AND user_id = $2`, [[r1.body.booking.id, r2.body.booking.id], org.dataId]);
  });

  it("owner sees the booking; portal link lists it for the contact", async () => {
    const list = await import("@/app/api/bookings/route");
    const from = new Date(new Date(slot).getTime() - 3_600_000).toISOString();
    const to = new Date(new Date(slot).getTime() + 3_600_000).toISOString();
    const r = await api<{ bookings: Array<{ id: string; status: string }> }>(list.GET, "/api/bookings", { query: { from, to }, expect: 200 });
    expect(r.body.bookings.map((b) => b.id)).toContain(booking.id);

    const portalLink = await import("@/app/api/crm/contacts/[id]/portal-link/route");
    const pl = await api<{ url: string; path: string }>(portalLink.POST, `/api/crm/contacts/${contactId}/portal-link`, { method: "POST", params: { id: contactId }, expect: 200 });
    const token = pl.body.path.split("/").pop() ?? "";
    const portal = await import("@/app/api/p/portal/[token]/route");
    const p = await api<{ contact: { id: string; email: string }; bookings: Array<{ id: string; status: string }> }>(portal.GET, `/api/p/portal/${token}`, { params: { token }, expect: 200 });
    expect(p.body.contact.id).toBe(contactId);
    expect(p.body.bookings.map((b) => b.id)).toContain(booking.id);
    await api(portal.GET, `/api/p/portal/bogus`, { params: { token: "bogus" }, expect: 404 });
  });

  it("cancels via the customer token, emits booking.cancelled, frees the slot; token is single-use", async () => {
    const cancel = await import("@/app/api/book/cancel/[token]/route");
    const r = await api<{ ok: boolean; booking: { id: string; status: string } }>(cancel.POST, `/api/book/cancel/${cancelToken}`, { method: "POST", params: { token: cancelToken }, expect: 200 });
    expect(r.body.booking.status).toBe("cancelled");
    const row = await sqlOne<{ status: string }>(`SELECT status FROM bookings WHERE id = $1`, [booking.id]);
    expect(row?.status).toBe("cancelled");
    await expectEvent(org.dataId, "booking.cancelled", booking.id);
    // second cancel is a no-op 200 (already cancelled), unknown token → 404
    const again = await api<{ booking: { status: string } }>(cancel.POST, `/api/book/cancel/${cancelToken}`, { method: "POST", params: { token: cancelToken }, expect: 200 });
    expect(again.body.booking.status).toBe("cancelled");
    await api(cancel.POST, `/api/book/cancel/unknown-token`, { method: "POST", params: { token: "unknown-token" }, expect: 404 });
    const pub = await import("@/app/api/book/[org]/[type]/route");
    const slots = await api<{ slots: string[] }>(pub.GET, `/api/book/${org.slug}/intro`, { params: { org: org.slug, type: "intro" }, expect: 200 });
    expect(slots.body.slots.map((s) => new Date(s).toISOString())).toContain(new Date(slot).toISOString());
    expect((await eventsFor(org.dataId, "booking.cancelled", booking.id)).length).toBe(1);
  });

  it("crew link shows today's booking; clock in/out writes time_entries", async () => {
    // A manual (staff) booking starting shortly, so it is "today" in UTC.
    const manual = await import("@/app/api/bookings/route");
    const startsAt = new Date(Date.now() + 60_000).toISOString();
    const m = await api<{ booking: { id: string; status: string; source: string } }>(manual.POST, "/api/bookings", {
      json: { name: "Walk-in", email: "walkin@example.test", startsAt, durationMinutes: 45 },
      expect: 201,
    });
    expect(m.body.booking.source).toBe("manual");

    const links = await import("@/app/api/team/crew-links/route");
    const c = await api<{ id: string; url: string; path: string }>(links.POST, "/api/team/crew-links", { json: { label: "Van 1", expiresDays: 7 }, expect: 201 });
    crewToken = c.body.path.split("/").pop() ?? "";
    expect(c.body.path.startsWith("/m/")).toBe(true);
    const listed = await api<{ links: Array<{ id: string; label: string; status: string }> }>(links.GET, "/api/team/crew-links", { expect: 200 });
    expect(listed.body.links.find((l) => l.id === c.body.id)?.status).toBe("active");

    const crew = await import("@/app/api/m/[token]/route");
    const day = await api<{ workspace: string; bookings: Array<{ id: string }>; timeTracking: boolean; clockedInAt: string | null; date: string }>(
      crew.GET, `/api/m/${crewToken}`, { query: { tz: "UTC" }, params: { token: crewToken }, expect: 200 }
    );
    expect(day.body.workspace).toBe(org.name);
    expect(day.body.bookings.map((b) => b.id)).toContain(m.body.booking.id);
    expect(day.body.bookings.map((b) => b.id)).not.toContain(booking.id); // cancelled / other day
    expect(day.body.timeTracking).toBe(true);
    expect(day.body.clockedInAt).toBeNull();

    const inn = await api<{ ok: boolean; entryId: string; startedAt: string }>(crew.POST, `/api/m/${crewToken}`, { json: { action: "clock_in" }, params: { token: crewToken }, expect: 200 });
    expect(inn.body.entryId).toBeTruthy();
    await api(crew.POST, `/api/m/${crewToken}`, { json: { action: "clock_in" }, params: { token: crewToken }, expect: 409 });
    const during = await api<{ clockedInAt: string | null }>(crew.GET, `/api/m/${crewToken}`, { params: { token: crewToken }, expect: 200 });
    expect(during.body.clockedInAt).toBeTruthy();
    const open = await sqlOne<{ ref_kind: string; ended_at: string | null }>(`SELECT ref_kind, ended_at FROM time_entries WHERE id = $1 AND user_id = $2`, [inn.body.entryId, org.dataId]);
    expect(open?.ref_kind).toBe("crew");
    expect(open?.ended_at).toBeNull();

    const out = await api<{ entryId: string; endedAt: string }>(crew.POST, `/api/m/${crewToken}`, { json: { action: "clock_out" }, params: { token: crewToken }, expect: 200 });
    expect(out.body.entryId).toBe(inn.body.entryId);
    const closed = await sqlOne<{ ended_at: string | null; minutes: number | null }>(`SELECT ended_at, minutes FROM time_entries WHERE id = $1`, [inn.body.entryId]);
    expect(closed?.ended_at).toBeTruthy();
    expect(closed?.minutes).not.toBeNull();
    await api(crew.POST, `/api/m/${crewToken}`, { json: { action: "clock_out" }, params: { token: crewToken }, expect: 409 });
    await api(crew.POST, `/api/m/${crewToken}`, { json: { action: "dance" }, params: { token: crewToken }, expect: 400 });

    // Revoke → 404
    await api(links.DELETE, `/api/team/crew-links`, { method: "DELETE", query: { id: c.body.id }, expect: 200 });
    await api(crew.GET, `/api/m/${crewToken}`, { params: { token: crewToken }, expect: 404 });
    await waitForRows(`SELECT action FROM audit_log WHERE user_id = $1 AND entity = 'crew_link'`, [org.dataId]);
  });

  it("viewer role cannot create booking types; unauthenticated is 401", async () => {
    const bt = await import("@/app/api/calendar/booking-types/route");
    setScope(org, { role: "viewer", userId: "itest-viewer" });
    await api(bt.POST, "/api/calendar/booking-types", { json: { name: "Nope" }, expect: 403 });
    setScope(null);
    await api(bt.GET, "/api/calendar/booking-types", { expect: 401 });
    setScope(org);
  });
});
