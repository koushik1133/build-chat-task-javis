/**
 * Team end-to-end: invite → accept via token → role matrix (viewer/member get
 * 403 on writes) → audit rows → agency child workspace → switch → rollup.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { AREAS, DEFAULT_MATRIX, type Area } from "@/lib/auth/roles";
import { api, cleanupDataIds, createTestOrg, describeDb, setScope, sql, sqlOne, waitForRows, type TestOrg } from "./setup";

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));

interface Member { id: string; userId: string | null; email: string | null; role: string; isOwner: boolean; isSelf: boolean }
interface Invite { id: string; email: string; role: string; expired: boolean }
interface Client { id: string; name: string; slug: string; dataId: string; kind: string; members: number; parentOrgId: string | null }

describeDb("team flow", () => {
  let org: TestOrg;
  const extraDataIds: string[] = [];
  const inviteeId = `itest-invitee-${randomUUID()}`;
  const inviteeEmail = `invitee-${randomUUID().slice(0, 6)}@example.test`;
  let inviteToken: string;
  let membershipId: string;
  let client: Client;

  beforeAll(async () => {
    org = await createTestOrg("team");
    setScope(org);
  });
  afterAll(async () => {
    await cleanupDataIds([org.dataId, ...extraDataIds]);
  });

  it("lists the owner, creates an invite, refuses an owner invite", async () => {
    const team = await import("@/app/api/team/route");
    const t = await api<{ orgId: string; role: string; members: Member[]; invites: Invite[] }>(team.GET, "/api/team", { expect: 200 });
    expect(t.body.orgId).toBe(org.orgId);
    expect(t.body.role).toBe("owner");
    expect(t.body.members).toHaveLength(1);
    expect(t.body.members[0]).toMatchObject({ userId: org.userId, isOwner: true, isSelf: true });

    const invite = await import("@/app/api/team/invite/route");
    await api(invite.POST, "/api/team/invite", { json: { email: inviteeEmail, role: "owner" }, expect: 403 });
    await api(invite.POST, "/api/team/invite", { json: { email: "nope", role: "viewer" }, expect: 400 });
    const r = await api<{ inviteUrl: string; email: string; role: string }>(invite.POST, "/api/team/invite", { json: { email: inviteeEmail.toUpperCase(), role: "viewer" }, expect: 200 });
    expect(r.body.email).toBe(inviteeEmail);
    inviteToken = r.body.inviteUrl.split("/invite/")[1] ?? "";
    expect(inviteToken).toMatch(/^[a-f0-9]{64}$/);
    expect(r.body.inviteUrl.startsWith(process.env.NEXT_PUBLIC_APP_URL ?? "")).toBe(true);

    const row = await sqlOne<{ id: string; status: string; invite_token_hash: string; role: string }>(`SELECT id, status, invite_token_hash, role FROM memberships WHERE org_id = $1 AND invited_email = $2`, [org.orgId, inviteeEmail]);
    expect(row?.status).toBe("invited");
    expect(row?.invite_token_hash).toMatch(/^[a-f0-9]{64}$/);
    membershipId = row?.id ?? "";
    // Re-inviting re-issues the token (one pending row) and can change the role.
    const again = await api<{ inviteUrl: string }>(invite.POST, "/api/team/invite", { json: { email: inviteeEmail, role: "member" }, expect: 200 });
    inviteToken = again.body.inviteUrl.split("/invite/")[1] ?? "";
    expect(await sql(`SELECT id FROM memberships WHERE org_id = $1 AND invited_email = $2`, [org.orgId, inviteeEmail])).toHaveLength(1);
    const pending = await api<{ invites: Invite[] }>(team.GET, "/api/team", { expect: 200 });
    expect(pending.body.invites).toEqual([expect.objectContaining({ id: membershipId, role: "member", expired: false })]);
  });

  it("the invitee accepts via token; the token is single-use", async () => {
    const accept = await import("@/app/api/team/accept/route");
    setScope(null);
    await api(accept.POST, "/api/team/accept", { json: { token: inviteToken }, expect: 401 });
    // The invitee is signed in as a different user with no org of their own in this harness.
    setScope(org, { userId: inviteeId, email: inviteeEmail, role: "viewer" });
    await api(accept.POST, "/api/team/accept", { json: { token: "zz" }, expect: 400 });
    const r = await api<{ ok: boolean; orgId: string; role: string }>(accept.POST, "/api/team/accept", { json: { token: inviteToken }, expect: 200 });
    expect(r.body).toMatchObject({ ok: true, orgId: org.orgId, role: "member" });
    expect(r.res.headers.get("set-cookie")).toContain(`kh_org=${org.orgId}`);
    const row = await sqlOne<{ status: string; user_id: string; invite_token_hash: string | null; accepted_at: string | null }>(`SELECT status, user_id, invite_token_hash, accepted_at FROM memberships WHERE id = $1`, [membershipId]);
    expect(row).toMatchObject({ status: "active", user_id: inviteeId, invite_token_hash: null });
    expect(row?.accepted_at).toBeTruthy();
    await api(accept.POST, "/api/team/accept", { json: { token: inviteToken }, expect: 404 });

    // Expired invites are refused with 410.
    const invite = await import("@/app/api/team/invite/route");
    setScope(org);
    const old = await api<{ inviteUrl: string }>(invite.POST, "/api/team/invite", { json: { email: `old-${inviteeEmail}`, role: "viewer" }, expect: 200 });
    await sql(`UPDATE memberships SET created_at = NOW() - INTERVAL '8 days' WHERE org_id = $1 AND invited_email = $2`, [org.orgId, `old-${inviteeEmail}`]);
    setScope(org, { userId: `itest-late-${randomUUID()}`, email: `late@example.test`, role: "viewer" });
    await api(accept.POST, "/api/team/accept", { json: { token: old.body.inviteUrl.split("/invite/")[1] }, expect: 410 });
    setScope(org);
    const team = await import("@/app/api/team/route");
    const t = await api<{ members: Member[] }>(team.GET, "/api/team", { expect: 200 });
    expect(t.body.members.map((m) => m.userId)).toEqual(expect.arrayContaining([org.userId, inviteeId]));
  });

  it("role matrix: viewer gets 403 on every write route, 200 on reads; member matches DEFAULT_MATRIX", async () => {
    const contacts = await import("@/app/api/crm/contacts/route");
    const quotes = await import("@/app/api/quotes/route");
    const tickets = await import("@/app/api/helpdesk/tickets/route");
    const team = await import("@/app/api/team/route");
    const invite = await import("@/app/api/team/invite/route");
    const audit = await import("@/app/api/audit/route");

    setScope(org, { role: "viewer", userId: inviteeId, email: inviteeEmail });
    for (const area of AREAS as readonly Area[]) expect(DEFAULT_MATRIX.viewer[area].edit, `viewer should not edit ${area}`).toBe(false);
    await api(contacts.POST, "/api/crm/contacts", { json: { full_name: "V" }, expect: 403 });
    await api(quotes.POST, "/api/quotes", { json: { items: [] }, expect: 403 });
    await api(tickets.POST, "/api/helpdesk/tickets", { json: { subject: "v" }, expect: 403 });
    await api(invite.POST, "/api/team/invite", { json: { email: "x@example.test", role: "viewer" }, expect: 403 });
    await api(team.GET, "/api/team", { expect: 403 }); // team area is NONE for viewers
    await api(audit.GET, "/api/audit", { expect: 403 }); // settings area is NONE
    await api(contacts.GET, "/api/crm/contacts", { expect: 200 });
    await api(quotes.GET, "/api/quotes", { expect: 200 });
    await api(tickets.GET, "/api/helpdesk/tickets", { expect: 200 });

    // member: crm/helpdesk edit allowed, billing view-only, team none
    setScope(org, { role: "member", userId: inviteeId, email: inviteeEmail });
    const c = await api<{ contact: { id: string } }>(contacts.POST, "/api/crm/contacts", { json: { full_name: "By member" }, expect: 201 });
    expect(c.body.contact.id).toBeTruthy();
    await api(tickets.POST, "/api/helpdesk/tickets", { json: { subject: "By member" }, expect: 201 });
    await api(quotes.POST, "/api/quotes", { json: { items: [] }, expect: 403 });
    await api(quotes.GET, "/api/quotes", { expect: 200 });
    await api(team.GET, "/api/team", { expect: 403 });

    // per-call override: an org-level area override that grants a viewer billing edit
    setScope(org, { role: "viewer", userId: inviteeId, can: (area, edit) => area === "billing" || !edit });
    await api(quotes.POST, "/api/quotes", { json: { items: [{ description: "x", qty: 1, unit_minor: 100 }] }, expect: 201 });
    await api(contacts.POST, "/api/crm/contacts", { json: { full_name: "still no" }, expect: 403 });

    // admin may manage roles but not touch the owner
    setScope(org, { role: "admin", userId: inviteeId });
    const member = await import("@/app/api/team/[id]/route");
    const ownerRow = await sqlOne<{ id: string }>(`SELECT id FROM memberships WHERE org_id = $1 AND role = 'owner'`, [org.orgId]);
    await api(member.PATCH, `/api/team/${ownerRow?.id}`, { method: "PATCH", json: { role: "viewer" }, params: { id: ownerRow?.id ?? "" }, expect: 403 });
    await api(member.PATCH, `/api/team/${membershipId}`, { method: "PATCH", json: { role: "owner" }, params: { id: membershipId }, expect: 403 });
    const ok = await api<{ ok: boolean; role: string }>(member.PATCH, `/api/team/${membershipId}`, { method: "PATCH", json: { role: "manager" }, params: { id: membershipId }, expect: 200 });
    expect(ok.body.role).toBe("manager");
    expect((await sqlOne<{ role: string }>(`SELECT role FROM memberships WHERE id = $1`, [membershipId]))?.role).toBe("manager");
    setScope(org);
  });

  it("audit rows are written for audited actions and listed via /api/audit", async () => {
    const links = await import("@/app/api/team/crew-links/route");
    const c = await api<{ id: string }>(links.POST, "/api/team/crew-links", { json: { label: "Audit me" }, expect: 201 });
    const exp = await import("@/app/api/export/[entity]/route");
    await api(exp.GET, "/api/export/contacts", { query: { format: "json" }, params: { entity: "contacts" }, expect: 200 });

    const rows = await waitForRows<{ action: string; entity: string; entity_id: string | null; actor_id: string | null }>(`SELECT action, entity, entity_id, actor_id FROM audit_log WHERE user_id = $1 AND entity IN ('crew_link', 'contacts') ORDER BY created_at ASC`, [org.dataId], 2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "create", entity: "crew_link", entity_id: c.body.id, actor_id: org.userId }),
      expect.objectContaining({ action: "export", entity: "contacts" }),
    ]));
    const audit = await import("@/app/api/audit/route");
    const a = await api<{ entries: Array<{ action: string; entity: string; diff: Record<string, unknown> | null }>; nextBefore: string | null }>(audit.GET, "/api/audit", { expect: 200 });
    expect(a.body.entries.length).toBeGreaterThanOrEqual(2);
    expect(a.body.entries.map((e) => e.entity)).toEqual(expect.arrayContaining(["crew_link", "contacts"]));
    const filtered = await api<{ entries: Array<{ entity: string }> }>(audit.GET, "/api/audit", { query: { entity: "crew_link" }, expect: 200 });
    expect(filtered.body.entries.every((e) => e.entity === "crew_link")).toBe(true);
    expect(filtered.body.entries.length).toBeGreaterThanOrEqual(1);
  });

  it("agency: creates a client workspace, switches into it, and the rollup reports its activity", async () => {
    const ws = await import("@/app/api/agency/workspaces/route");
    const r = await api<{ client: Client }>(ws.POST, "/api/agency/workspaces", { json: { name: "Acme Client", slug: `acme-${org.slug}` }, expect: 201 });
    client = r.body.client;
    extraDataIds.push(client.dataId);
    expect(client.dataId).toBe(client.id);
    expect(client.kind).toBe("client");
    expect(client.parentOrgId).toBe(org.orgId);
    expect(client.members).toBe(1);
    const seat = await sqlOne<{ role: string; status: string }>(`SELECT role, status FROM memberships WHERE org_id = $1 AND user_id = $2`, [client.id, org.userId]);
    expect(seat).toMatchObject({ role: "owner", status: "active" });
    expect((await sqlOne<{ kind: string }>(`SELECT kind FROM organizations WHERE id = $1`, [org.orgId]))?.kind).toBe("agency");
    const list = await api<{ clients: Client[]; org: { kind: string }; canEdit: boolean }>(ws.GET, "/api/agency/workspaces", { expect: 200 });
    expect(list.body.clients.map((c) => c.id)).toContain(client.id);
    expect(list.body.org.kind).toBe("agency");
    await waitForRows(`SELECT id FROM audit_log WHERE user_id = $1 AND entity = 'client_workspace' AND entity_id = $2`, [org.dataId, client.id]);
    // a manager cannot create client workspaces even with settings edit granted
    setScope(org, { role: "manager", userId: inviteeId, can: () => true });
    await api(ws.POST, "/api/agency/workspaces", { json: { name: "Nope" }, expect: 403 });
    setScope(org);

    // switch: owner has a seat on the child; a stranger does not
    const sw = await import("@/app/api/agency/switch/route");
    const s = await api<{ ok: boolean; activeOrgId: string }>(sw.POST, "/api/agency/switch", { json: { orgId: client.id }, expect: 200 });
    expect(s.body.activeOrgId).toBe(client.id);
    expect(s.res.headers.get("set-cookie")).toContain(`kh_org=${client.id}`);
    setScope(org, { userId: `itest-stranger-${randomUUID()}` });
    await api(sw.POST, "/api/agency/switch", { json: { orgId: client.id }, expect: 403 });

    // Work inside the client workspace: a draft quote and a paid invoice.
    const childOrg: TestOrg = { dataId: client.dataId, orgId: client.id, userId: org.userId, email: org.email, slug: client.slug, name: client.name };
    setScope(childOrg);
    const quotes = await import("@/app/api/quotes/route");
    await api(quotes.POST, "/api/quotes", { json: { items: [{ description: "Retainer", qty: 1, unit_minor: 50000 }] }, expect: 201 });
    const invoices = await import("@/app/api/invoices/route");
    const inv = await api<{ invoice: { id: string } }>(invoices.POST, "/api/invoices", { json: { items: [{ description: "Setup", qty: 1, unit_minor: 12000 }] }, expect: 201 });
    const payLink = await import("@/app/api/invoices/[id]/pay-link/route");
    const pl = await api<{ token: string }>(payLink.POST, `/api/invoices/${inv.body.invoice.id}/pay-link`, { method: "POST", params: { id: inv.body.invoice.id }, expect: 201 });
    const pay = await import("@/app/api/p/pay/[token]/route");
    const paid = await api<{ status: string }>(pay.POST, `/api/p/pay/${pl.body.token}`, { json: { outcome: "success" }, params: { token: pl.body.token }, expect: 200 });
    expect(paid.body.status).toBe("paid");
    // Child data is keyed by the child id, never the parent.
    expect(await sql(`SELECT id FROM invoices WHERE user_id = $1`, [client.dataId])).toHaveLength(1);
    expect(await sql(`SELECT id FROM invoices WHERE user_id = $1`, [org.dataId])).toHaveLength(0);

    setScope(org);
    const rollup = await import("@/app/api/agency/rollup/route");
    const rep = await api<{ report: { rows: Array<{ org: { id: string }; revenue_minor: number; paid_invoices: number; open_quotes: number; open_quotes_minor: number; currency: string }>; totals: { clients: number; revenue_minor: number; open_quotes: number } } }>(
      rollup.GET, "/api/agency/rollup", { expect: 200 }
    );
    const row = rep.body.report.rows.find((x) => x.org.id === client.id);
    expect(row).toMatchObject({ revenue_minor: 12000, paid_invoices: 1, open_quotes: 1, open_quotes_minor: 50000, currency: "USD" });
    expect(rep.body.report.totals).toMatchObject({ clients: 1, revenue_minor: 12000, open_quotes: 1 });
    await api(rollup.GET, "/api/agency/rollup", { query: { from: "2030-01-01", to: "2020-01-01" }, expect: 400 });
    // A client workspace cannot own workspaces of its own.
    setScope(childOrg);
    await api(ws.POST, "/api/agency/workspaces", { json: { name: "Grandchild" }, expect: 403 });
    setScope(org);
  });
});
