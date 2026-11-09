/**
 * Helpdesk end-to-end: SLA policy → widget ticket (CORS) → numbering → agent
 * reply stamps first_responded_at → customer reply reopens → SLA sweep flags
 * once → KB publish → public help center → KB search.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { api, call, cleanupDataIds, createTestOrg, describeDb, eventsFor, expectEvent, req, setScope, sleep, sql, sqlOne, type TestOrg } from "./setup";

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));

interface Ticket { id: string; number: number | string; status: string; first_responded_at: string | null; sla_policy_id: string | null; first_response_due_at: string | null }

describeDb("helpdesk flow", () => {
  let org: TestOrg;
  let policyId: string;
  let siteId: string;
  let ticket: Ticket;
  let articleId: string;
  let articleSlug: string;

  beforeAll(async () => {
    org = await createTestOrg("helpdesk");
    setScope(org);
    siteId = randomUUID();
    await sql(
      `INSERT INTO sites (id, user_id, title, html, allowed_origins, created_at, updated_at) VALUES ($1, $2, 'Support site', '<html></html>', $3, NOW(), NOW())`,
      [siteId, org.dataId, "https://widget.example.test"]
    );
  });
  afterAll(async () => {
    await cleanupDataIds([org.dataId]);
  });

  it("creates a default SLA policy with a short first-response target", async () => {
    const sla = await import("@/app/api/helpdesk/sla/route");
    const r = await api<{ policy: { id: string; is_default: boolean; first_response_minutes: number } }>(sla.POST, "/api/helpdesk/sla", {
      json: { name: "Standard", first_response_minutes: 60, resolution_minutes: 480, is_default: true, priority_overrides: { urgent: { first_response_minutes: 15 } } },
      expect: 201,
    });
    policyId = r.body.policy.id;
    expect(r.body.policy.is_default).toBe(true);
    await api(sla.POST, "/api/helpdesk/sla", { json: { name: "", first_response_minutes: 0 }, expect: 400 });
    const list = await api<{ policies: Array<{ id: string }> }>(sla.GET, "/api/helpdesk/sla", { expect: 200 });
    expect(list.body.policies.map((p) => p.id)).toContain(policyId);
  });

  it("widget creates a customer ticket with CORS headers, SLA due times and sequential numbers", async () => {
    const widget = await import("@/app/api/helpdesk/widget/[siteId]/route");
    const pre = await call(widget.OPTIONS, req(`/api/helpdesk/widget/${siteId}`, { method: "OPTIONS", headers: { origin: "https://widget.example.test" } }), { siteId }, 204);
    expect(pre.res.headers.get("access-control-allow-origin")).toBe("https://widget.example.test");
    expect(pre.res.headers.get("access-control-allow-methods")).toContain("POST");

    const r = await api<{ success: boolean; ticket: { id: string; number: string; status: string } }>(widget.POST, `/api/helpdesk/widget/${siteId}`, {
      json: { name: "Widget User", email: "widget-user@example.test", subject: "Cannot log in", body: "The login button does nothing." },
      headers: { origin: "https://widget.example.test", "x-forwarded-for": "198.51.100.7" },
      params: { siteId },
      expect: 201,
    });
    expect(r.res.headers.get("access-control-allow-origin")).toBe("https://widget.example.test");
    expect(r.res.headers.get("vary")).toContain("Origin");
    expect(r.body.ticket.status).toBe("open");
    expect(r.body.ticket.number).toMatch(/^#?[A-Z-]*\d+$/);

    // Foreign origin is not echoed back.
    const foreign = await api(widget.POST, `/api/helpdesk/widget/${siteId}`, {
      json: { name: "X", email: "x@example.test", subject: "s", body: "b" },
      headers: { origin: "https://evil.example.test", "x-forwarded-for": "198.51.100.8" },
      params: { siteId },
      expect: 201,
    });
    expect(foreign.res.headers.get("access-control-allow-origin")).toBeNull();
    await api(widget.POST, `/api/helpdesk/widget/not-a-uuid`, { json: {}, params: { siteId: "not-a-uuid" }, expect: 400 });
    await api(widget.POST, `/api/helpdesk/widget/${randomUUID()}`, { json: { name: "X", email: "x@example.test", subject: "s", body: "b" }, params: { siteId: randomUUID() }, expect: 404 });

    const rows = await sql<Ticket & { source: string; requester_email: string; tags: string }>(
      `SELECT id, number, status, source, requester_email, tags, sla_policy_id, first_response_due_at, first_responded_at FROM tickets WHERE user_id = $1 ORDER BY number ASC`, [org.dataId]
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((t) => Number(t.number))).toEqual([Number(rows[0].number), Number(rows[0].number) + 1]);
    ticket = rows[0];
    expect(ticket.sla_policy_id).toBe(policyId);
    expect(ticket.first_response_due_at).toBeTruthy();
    expect(rows[0].source).toBe("widget");
    expect(rows[0].requester_email).toBe("widget-user@example.test");
    expect(rows[0].tags).toContain("widget");
    const msg = await sqlOne<{ author_kind: string; is_internal: boolean }>(`SELECT author_kind, is_internal FROM ticket_messages WHERE ticket_id = $1`, [ticket.id]);
    expect(msg?.author_kind).toBe("customer");
    await expectEvent(org.dataId, "ticket.created", ticket.id);
  });

  it("agent reply stamps first_responded_at, moves to pending and emails the requester", async () => {
    const messages = await import("@/app/api/helpdesk/tickets/[id]/messages/route");
    // internal note first: no first_responded_at, no email
    const note = await api<{ ticket: Ticket; emailed: boolean }>(messages.POST, `/api/helpdesk/tickets/${ticket.id}/messages`, {
      json: { body: "Checking the auth logs", is_internal: true }, params: { id: ticket.id }, expect: 201,
    });
    expect(note.body.emailed).toBe(false);
    expect(note.body.ticket.first_responded_at).toBeNull();
    expect(note.body.ticket.status).toBe("open");

    const r = await api<{ ticket: Ticket; emailed: boolean; message: { is_internal: boolean } }>(messages.POST, `/api/helpdesk/tickets/${ticket.id}/messages`, {
      json: { body: "Thanks, please clear your cookies and retry." }, params: { id: ticket.id }, expect: 201,
    });
    expect(r.body.emailed).toBe(true);
    expect(r.body.ticket.first_responded_at).toBeTruthy();
    expect(r.body.ticket.status).toBe("pending");
    const firstResponded = r.body.ticket.first_responded_at;
    const mail = await sqlOne<{ subject: string }>(`SELECT subject FROM notification_outbox WHERE user_id = $1 AND recipient = 'widget-user@example.test' AND data LIKE '%ticket.reply%'`, [org.dataId]);
    expect(mail?.subject).toContain("Re: Cannot log in");
    await expectEvent(org.dataId, "ticket.replied", ticket.id);

    // A second public reply does not re-stamp.
    const again = await api<{ ticket: Ticket }>(messages.POST, `/api/helpdesk/tickets/${ticket.id}/messages`, { json: { body: "Any luck?" }, params: { id: ticket.id }, expect: 201 });
    expect(new Date(again.body.ticket.first_responded_at ?? 0).getTime()).toBe(new Date(firstResponded ?? 0).getTime());
    await api(messages.POST, `/api/helpdesk/tickets/${randomUUID()}/messages`, { json: { body: "x" }, params: { id: randomUUID() }, expect: 404 });
  });

  it("customer reply (portal) reopens the pending ticket; portal GET hides internal notes", async () => {
    // The portal token belongs to the requester's contact.
    const contacts = await import("@/app/api/crm/contacts/route");
    const c = await api<{ contact: { id: string } }>(contacts.POST, "/api/crm/contacts", { json: { full_name: "Widget User", email: "widget-user@example.test" }, expect: 201 });
    await sql(`UPDATE tickets SET contact_id = $2 WHERE id = $1`, [ticket.id, c.body.contact.id]);
    const portalLink = await import("@/app/api/crm/contacts/[id]/portal-link/route");
    const pl = await api<{ path: string }>(portalLink.POST, `/api/crm/contacts/${c.body.contact.id}/portal-link`, { method: "POST", params: { id: c.body.contact.id }, expect: 200 });
    const token = pl.body.path.split("/").pop() ?? "";

    const portal = await import("@/app/api/p/tickets/[token]/route");
    const list = await api<{ tickets: Array<{ id: string; status: string }> }>(portal.GET, `/api/p/tickets/${token}`, { params: { token }, expect: 200 });
    expect(list.body.tickets.map((t) => t.id)).toContain(ticket.id);
    const thread = await api<{ ticket: { status: string }; messages: Array<{ author_kind: string; body: string }> }>(portal.GET, `/api/p/tickets/${token}`, { query: { id: ticket.id }, params: { token }, expect: 200 });
    expect(thread.body.ticket.status).toBe("pending");
    expect(thread.body.messages.map((m) => m.body)).not.toContain("Checking the auth logs");
    expect(thread.body.messages.map((m) => m.author_kind).sort()).toEqual(["support", "support", "you"]);

    // Customer reply (the portal page posts through addMessage with author_kind=customer).
    const { addMessage } = await import("@/lib/helpdesk/tickets");
    const out = await addMessage(org.dataId, ticket.id, { author_kind: "customer", author_id: c.body.contact.id, body: "Still broken after clearing cookies.", is_internal: true });
    expect(out.message.is_internal).toBe(false); // customers can never write internal notes
    expect(out.ticket.status).toBe("open");
    const row = await sqlOne<{ status: string }>(`SELECT status FROM tickets WHERE id = $1`, [ticket.id]);
    expect(row?.status).toBe("open");

    // Portal can also open a new ticket for this contact.
    const created = await api<{ ticket: { id: string; status: string } }>(portal.POST, `/api/p/tickets/${token}`, { json: { subject: "Billing question", body: "Why was I charged twice?" }, params: { token }, expect: 201 });
    const t2 = await sqlOne<{ source: string; contact_id: string }>(`SELECT source, contact_id FROM tickets WHERE id = $1`, [created.body.ticket.id]);
    expect(t2?.source).toBe("portal");
    expect(t2?.contact_id).toBe(c.body.contact.id);
  });

  it("runSlaSweep flags an overdue first response exactly once", async () => {
    // Make the second (untouched) ticket overdue.
    const overdue = await sqlOne<{ id: string }>(`SELECT id FROM tickets WHERE user_id = $1 AND first_responded_at IS NULL AND source = 'widget' ORDER BY number DESC LIMIT 1`, [org.dataId]);
    expect(overdue).toBeTruthy();
    await sql(`UPDATE tickets SET first_response_due_at = NOW() - INTERVAL '5 minutes' WHERE id = $1`, [overdue?.id]);
    const { runSlaSweep } = await import("@/lib/helpdesk/tickets");
    const first = await runSlaSweep(500);
    expect(first.breachedFirstResponse).toBeGreaterThanOrEqual(1);
    const row = await sqlOne<{ breached_first_response: boolean; status: string }>(`SELECT breached_first_response, status FROM tickets WHERE id = $1`, [overdue?.id]);
    expect(row?.breached_first_response).toBe(true);
    await expectEvent(org.dataId, "ticket.sla_breached", overdue?.id);
    const notes = await sql(`SELECT id FROM notification_outbox WHERE user_id = $1 AND data LIKE '%ticket.sla_breached%' AND data LIKE '%' || $2 || '%'`, [org.dataId, overdue?.id]);
    expect(notes).toHaveLength(1);

    await runSlaSweep(500);
    expect((await eventsFor(org.dataId, "ticket.sla_breached", overdue?.id)).length).toBe(1);
    const notesAgain = await sql(`SELECT id FROM notification_outbox WHERE user_id = $1 AND data LIKE '%ticket.sla_breached%' AND data LIKE '%' || $2 || '%'`, [org.dataId, overdue?.id]);
    expect(notesAgain).toHaveLength(1);
    // The answered ticket was not flagged.
    const answered = await sqlOne<{ breached_first_response: boolean }>(`SELECT breached_first_response FROM tickets WHERE id = $1`, [ticket.id]);
    expect(answered?.breached_first_response).toBe(false);
  });

  it("publishes a KB article; help center lists it; search finds it", async () => {
    const articles = await import("@/app/api/kb/articles/route");
    const draft = await api<{ article: { id: string; slug: string; status: string; is_public: boolean } }>(articles.POST, "/api/kb/articles", {
      json: { title: "Reset your password", body_md: "# Reset\n\nUse the **Forgot password** link on the login page, then check your email for the zebra-token.", category: "Account", tags: ["login"] },
      expect: 201,
    });
    articleId = draft.body.article.id;
    articleSlug = draft.body.article.slug;
    expect(draft.body.article.status).toBe("draft");
    expect(articleSlug).toMatch(/^reset-your-password/);

    const help = await import("@/app/api/help/[org]/route");
    const before = await api<{ articles: Array<{ id: string }> }>(help.GET, `/api/help/${org.slug}`, { params: { org: org.slug }, expect: 200 });
    expect(before.body.articles.map((a) => a.id)).not.toContain(articleId);

    const one = await import("@/app/api/kb/articles/[id]/route");
    const pub = await api<{ article: { status: string; is_public: boolean; published_at: string | null } }>(one.PATCH, `/api/kb/articles/${articleId}`, {
      method: "PATCH", json: { status: "published", is_public: true }, params: { id: articleId }, expect: 200,
    });
    expect(pub.body.article.status).toBe("published");
    expect(pub.body.article.published_at).toBeTruthy();

    const after = await api<{ org: { slug: string }; articles: Array<{ id: string; slug: string }>; categories: Array<{ slug: string; count?: number }> }>(help.GET, `/api/help/${org.slug}`, { params: { org: org.slug }, expect: 200 });
    expect(after.body.org.slug).toBe(org.slug);
    expect(after.body.articles.map((a) => a.id)).toContain(articleId);
    const detail = await import("@/app/api/help/[org]/[slug]/route");
    const d = await api<{ article: { id: string; title: string; body_md?: string; body_html?: string } }>(detail.GET, `/api/help/${org.slug}/${articleSlug}`, { params: { org: org.slug, slug: articleSlug }, expect: 200 });
    expect(d.body.article.id).toBe(articleId);
    // The view counter is incremented fire-and-forget; give it a moment.
    let views = 0;
    for (let i = 0; i < 20 && views < 1; i++) {
      views = Number((await sqlOne<{ views: number }>(`SELECT views FROM kb_articles WHERE id = $1`, [articleId]))?.views ?? 0);
      if (views < 1) await sleep(25);
    }
    expect(views).toBeGreaterThanOrEqual(1);
    await api(help.GET, `/api/help/no-such-org-${org.slug}`, { params: { org: `no-such-org-${org.slug}` }, expect: 404 });

    const publicSearch = await api<{ articles: Array<{ id: string }>; q: string }>(help.GET, `/api/help/${org.slug}`, { query: { q: "zebra-token" }, params: { org: org.slug }, expect: 200 });
    expect(publicSearch.body.articles.map((a) => a.id)).toContain(articleId);
    const search = await import("@/app/api/kb/search/route");
    const hits = await api<{ hits: Array<{ id: string; score?: number }> }>(search.GET, "/api/kb/search", { query: { q: "forgot password" }, expect: 200 });
    expect(hits.body.hits.map((h) => h.id)).toContain(articleId);
    const none = await api<{ hits: unknown[] }>(search.GET, "/api/kb/search", { query: { q: "" }, expect: 200 });
    expect(none.body.hits).toEqual([]);
  });

  it("role matrix: viewer cannot create tickets or publish articles", async () => {
    setScope(org, { role: "viewer", userId: "itest-viewer" });
    const tickets = await import("@/app/api/helpdesk/tickets/route");
    await api(tickets.POST, "/api/helpdesk/tickets", { json: { subject: "x" }, expect: 403 });
    const listed = await api<{ tickets: unknown[] }>(tickets.GET, "/api/helpdesk/tickets", { query: { status: "all" }, expect: 200 });
    expect(listed.body.tickets.length).toBeGreaterThanOrEqual(3);
    const one = await import("@/app/api/kb/articles/[id]/route");
    await api(one.PATCH, `/api/kb/articles/${articleId}`, { method: "PATCH", json: { status: "draft" }, params: { id: articleId }, expect: 403 });
    setScope(org);
  });
});
