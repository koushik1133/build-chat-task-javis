/**
 * Phase 8 lane D: marketing.
 *
 * contacts with/without consent → audience count + eligible → template →
 * campaign → launch (recipients queued / skipped_no_consent; 0-eligible blocked)
 * → sendBatch → outbox rows tagged marketing with tracking links →
 * open pixel → click redirect (disallowed URL 400) → unsubscribe (consent
 * withdrawn, recipient status) → syncDeliveryStatuses → stats → sequence
 * enroll + runDueEnrollments → test-send → API v1 (list/get/launch, 401/403).
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { api, cleanupDataIds, createTestOrg, describeDb, expectEvent, setScope, sql, sqlOne, tableExists, type TestOrg } from "./setup";

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));

type Env<T> = { data: T; meta?: { next_cursor: string | null } };
interface CampaignDTO {
  id: string;
  status: string;
  channel: string;
  subject: string | null;
  body_md: string;
}
interface Stats {
  total: number;
  queued: number;
  skipped_no_consent: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  unsubscribed: number;
  open_rate: number;
}

const MARKETING_TABLES = ["audiences", "email_templates", "campaigns", "campaign_recipients", "sequences", "sequence_enrollments", "link_clicks"];

describeDb("marketing flow", () => {
  let org: TestOrg;
  let ready = false;
  let consented: string;
  let consented2: string;
  let noConsent: string;
  let audienceId: string;
  let templateId: string;
  let campaignId: string;
  let recipientConsented: string;
  let openToken: string;
  let clickUrl: string;
  let unsubToken: string;

  beforeAll(async () => {
    org = await createTestOrg("marketing");
    setScope(org);
    ready = true;
    for (const t of MARKETING_TABLES) if (!(await tableExists(t))) ready = false;
    if (!ready) console.warn("[integration] marketing tables missing — apply aws/phase8/d.sql");
  });
  afterAll(async () => {
    await cleanupDataIds([org.dataId]);
  });

  it("contacts + consent → audience resolves and reports eligibility", async (ctx) => {
    if (!ready) return ctx.skip();
    const contacts = await import("@/app/api/crm/contacts/route");
    const mk = async (name: string, email: string) => (await api<{ contact: { id: string } }>(contacts.POST, "/api/crm/contacts", { json: { full_name: name, email, phone: `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`, company: "Mkt Co", lifecycle: "customer" }, expect: 201 })).body.contact.id;
    consented = await mk("Casey Consent", `casey-${org.slug}@example.test`);
    consented2 = await mk("Dana Consent", `dana-${org.slug}@example.test`);
    noConsent = await mk("Noel Nope", `noel-${org.slug}@example.test`);
    const { recordConsent } = await import("@/lib/privacy/consent");
    await recordConsent(org.dataId, { kind: "contact", id: consented }, "marketing_email", "granted", "manual");
    await recordConsent(org.dataId, { kind: "contact", id: consented2 }, "marketing_email", "granted", "manual");

    const aud = await import("@/app/api/marketing/audiences/route");
    const bad = await api(aud.POST, "/api/marketing/audiences", { json: { name: "x", definition: { lifecycle: ["admin"] } }, expect: 400 });
    expect(bad.status).toBe(400);
    const created = await api<{ audience: { id: string; size_cache: number } }>(aud.POST, "/api/marketing/audiences", { json: { name: "Customers", definition: { lifecycle: ["customer"], has_email: true } }, expect: 201 });
    audienceId = created.body.audience.id;
    expect(created.body.audience.size_cache).toBe(3);

    const preview = await import("@/app/api/marketing/audiences/[id]/preview/route");
    const p = await api<{ count: number; eligible: number; sample: unknown[] }>(preview.GET, `/api/marketing/audiences/${audienceId}/preview`, { query: { channel: "email" }, params: { id: audienceId }, expect: 200 });
    expect(p.body.count).toBe(3);
    expect(p.body.eligible).toBe(2);
    expect(p.body.sample).toHaveLength(3);

    const live = await import("@/app/api/marketing/preview/route");
    const lp = await api<{ count: number; eligible: number }>(live.POST, "/api/marketing/preview", { json: { definition: { q: "Nope" }, channel: "email" }, expect: 200 });
    expect(lp.body).toMatchObject({ count: 1, eligible: 0 });
  });

  it("template → campaign → launch queues consented and skips the rest; 0-eligible launch is blocked", async (ctx) => {
    if (!ready) return ctx.skip();
    const tpl = await import("@/app/api/marketing/templates/route");
    const t = await api<{ template: { id: string } }>(tpl.POST, "/api/marketing/templates", {
      json: { name: "Promo", subject: "Hi {{first_name}} from {{org_name}}", preheader: "Big news", body_md: "# Hello {{first_name}}\n\nVisit [our site](https://example.test/offer) today.\n\n<script>x</script>", category: "promotion" },
      expect: 201,
    });
    templateId = t.body.template.id;

    const camps = await import("@/app/api/marketing/campaigns/route");
    const c = await api<{ campaign: CampaignDTO }>(camps.POST, "/api/marketing/campaigns", { json: { name: "Spring promo", channel: "email", audience_id: audienceId, template_id: templateId, from_name: "Mkt Co" }, expect: 201 });
    campaignId = c.body.campaign.id;
    expect(c.body.campaign.status).toBe("draft");
    expect(c.body.campaign.subject).toBe("Hi {{first_name}} from {{org_name}}");

    // Zero-eligible audience → blocked with an explanation.
    const aud = await import("@/app/api/marketing/audiences/route");
    const none = await api<{ audience: { id: string } }>(aud.POST, "/api/marketing/audiences", { json: { name: "No consent", definition: { q: "Nope" } }, expect: 201 });
    const blocked = await api<{ campaign: CampaignDTO }>(camps.POST, "/api/marketing/campaigns", { json: { name: "Blocked", channel: "email", audience_id: none.body.audience.id, subject: "s", body_md: "b" }, expect: 201 });
    const launch = await import("@/app/api/marketing/campaigns/[id]/launch/route");
    const b = await api<{ error: string; detail: string }>(launch.POST, `/api/marketing/campaigns/${blocked.body.campaign.id}/launch`, { json: {}, params: { id: blocked.body.campaign.id }, expect: 400 });
    expect(b.body.error).toBe("no_eligible");
    expect(b.body.detail).toMatch(/consent/i);
    expect(await sql(`SELECT id FROM campaign_recipients WHERE campaign_id = $1`, [blocked.body.campaign.id])).toHaveLength(0);

    const l = await api<{ campaign: CampaignDTO; queued: number; skipped_no_consent: number }>(launch.POST, `/api/marketing/campaigns/${campaignId}/launch`, { json: {}, params: { id: campaignId }, expect: 200 });
    expect(l.body.campaign.status).toBe("sending");
    expect(l.body.queued).toBe(2);
    expect(l.body.skipped_no_consent).toBe(1);
    const rows = await sql<{ contact_id: string; status: string }>(`SELECT contact_id, status FROM campaign_recipients WHERE campaign_id = $1`, [campaignId]);
    expect(rows.find((r) => r.contact_id === noConsent)?.status).toBe("skipped_no_consent");
    expect(rows.filter((r) => r.status === "queued")).toHaveLength(2);
    // Re-launching a sending campaign is refused.
    await api(launch.POST, `/api/marketing/campaigns/${campaignId}/launch`, { json: {}, params: { id: campaignId }, expect: 409 });
  });

  it("sendBatch enqueues marketing outbox rows with tracking links and closes the campaign", async (ctx) => {
    if (!ready) return ctx.skip();
    const { sendBatch } = await import("@/lib/marketing/campaigns");
    const r = await sendBatch(50);
    expect(r.sent).toBeGreaterThanOrEqual(2);
    expect(r.campaigns_finished).toBeGreaterThanOrEqual(1);
    const outbox = await sql<{ id: string; recipient: string; subject: string; body: string; data: string }>(
      `SELECT o.id, o.recipient, o.subject, o.body, o.data FROM notification_outbox o WHERE o.user_id = $1 AND o.data LIKE '%"category":"marketing"%' AND o.data LIKE $2 ORDER BY o.created_at ASC`,
      [org.dataId, `%${campaignId}%`]
    );
    expect(outbox).toHaveLength(2);
    const casey = outbox.find((o) => o.recipient.startsWith("casey"))!;
    expect(casey.subject).toBe(`Hi Casey from ${org.name}`);
    expect(casey.body).toContain("Hello Casey");
    expect(casey.body).not.toContain("<script>");
    expect(casey.body).toContain("/api/t/o/");
    expect(casey.body).toContain("/api/t/c/");
    expect(casey.body).toContain("/u/");
    const data = JSON.parse(casey.data) as { campaign_id: string; recipient_id: string; category: string; headers: Record<string, string>; fromName: string };
    expect(data).toMatchObject({ campaign_id: campaignId, category: "marketing", fromName: "Mkt Co" });
    expect(data.headers["List-Unsubscribe"]).toMatch(/^<http.*\/u\/.+>$/);
    recipientConsented = data.recipient_id;
    openToken = /\/api\/t\/o\/([A-Za-z0-9_.-]+)/.exec(casey.body)![1];
    clickUrl = /href="([^"]*\/api\/t\/c\/[^"]+)"/.exec(casey.body)![1].replace(/&amp;/g, "&");
    unsubToken = /\/u\/([A-Za-z0-9_.-]+)/.exec(casey.body)![1];

    const camp = await sqlOne<{ status: string; sent_count: number }>(`SELECT status, sent_count FROM campaigns WHERE id = $1`, [campaignId]);
    expect(camp).toMatchObject({ status: "sent", sent_count: 2 });
    await expectEvent(org.dataId, "campaign.sent", campaignId);
  });

  it("open pixel, click redirect (allow-list) and unsubscribe update recipient state and consent", async (ctx) => {
    if (!ready) return ctx.skip();
    const open = await import("@/app/api/t/o/[token]/route");
    const bad = await api(open.GET, "/api/t/o/not-a-token", { params: { token: "not-a-token" }, expect: 200 });
    expect(bad.res.headers.get("content-type")).toBe("image/gif");
    const ok = await api(open.GET, `/api/t/o/${openToken}`, { params: { token: openToken }, expect: 200 });
    expect(ok.res.headers.get("content-type")).toBe("image/gif");
    expect((await sqlOne<{ opened_at: string | null }>(`SELECT opened_at FROM campaign_recipients WHERE id = $1`, [recipientConsented]))?.opened_at).toBeTruthy();

    const click = await import("@/app/api/t/c/[token]/route");
    const u = new URL(clickUrl);
    const token = u.pathname.split("/").pop()!;
    const target = u.searchParams.get("u")!;
    expect(target).toBe("https://example.test/offer");
    const evil = await api(click.GET, `/api/t/c/${token}`, { query: { u: "https://evil.test/phish" }, params: { token }, expect: 400 });
    expect(evil.status).toBe(400);
    await api(click.GET, `/api/t/c/${token}`, { params: { token: "garbage.sig" }, expect: 404 });
    const good = await api(click.GET, `/api/t/c/${token}`, { query: { u: target }, params: { token }, expect: 302 });
    expect(good.res.headers.get("location")).toBe(target);
    expect(await sql(`SELECT id FROM link_clicks WHERE campaign_id = $1 AND url = $2`, [campaignId, target])).toHaveLength(1);
    await expectEvent(org.dataId, "campaign.recipient_clicked", campaignId);

    const unsub = await import("@/app/api/t/u/[token]/route");
    await api(unsub.GET, "/api/t/u/bad", { params: { token: "bad" }, expect: 404 });
    const info = await api<{ channel: string; already_unsubscribed: boolean }>(unsub.GET, `/api/t/u/${unsubToken}`, { params: { token: unsubToken }, expect: 200 });
    expect(info.body).toMatchObject({ channel: "email", already_unsubscribed: false });
    const done = await api<{ ok: boolean; withdrawn: string[] }>(unsub.POST, `/api/t/u/${unsubToken}`, { json: { all: true }, params: { token: unsubToken }, expect: 200 });
    expect(done.body.withdrawn).toEqual(["marketing_email", "marketing_sms"]);
    expect((await sqlOne<{ status: string }>(`SELECT status FROM campaign_recipients WHERE id = $1`, [recipientConsented]))?.status).toBe("unsubscribed");
    const { canSendMarketing } = await import("@/lib/privacy/consent");
    expect((await canSendMarketing(org.dataId, consented, "email")).allowed).toBe(false);
    await expectEvent(org.dataId, "contact.unsubscribed", consented);
    // idempotent
    const again = await api<{ already_unsubscribed: boolean }>(unsub.GET, `/api/t/u/${unsubToken}`, { params: { token: unsubToken }, expect: 200 });
    expect(again.body.already_unsubscribed).toBe(true);
  });

  it("delivery sync + stats + recipients listing", async (ctx) => {
    if (!ready) return ctx.skip();
    const { drainOutbox } = await import("@/lib/notifications/outbox");
    await drainOutbox(50); // simulated providers → status simulated
    const { syncDeliveryStatuses } = await import("@/lib/marketing/campaigns");
    const s = await syncDeliveryStatuses(100);
    expect(s.delivered).toBeGreaterThanOrEqual(1); // Dana; Casey already unsubscribed keeps her status
    const stats = await import("@/app/api/marketing/campaigns/[id]/stats/route");
    const st = await api<{ stats: Stats; links: Array<{ url: string; clicks: number }> }>(stats.GET, `/api/marketing/campaigns/${campaignId}/stats`, { params: { id: campaignId }, expect: 200 });
    expect(st.body.stats).toMatchObject({ total: 3, skipped_no_consent: 1, delivered: 1, unsubscribed: 1, opened: 1, clicked: 1, queued: 0 });
    expect(st.body.stats.open_rate).toBe(50);
    expect(st.body.links[0]).toMatchObject({ url: "https://example.test/offer", clicks: 1 });

    const rec = await import("@/app/api/marketing/campaigns/[id]/recipients/route");
    const r = await api<{ recipients: Array<{ status: string; full_name: string }>; next_cursor: string | null }>(rec.GET, `/api/marketing/campaigns/${campaignId}/recipients`, { query: { status: "skipped_no_consent" }, params: { id: campaignId }, expect: 200 });
    expect(r.body.recipients).toHaveLength(1);
    expect(r.body.recipients[0].full_name).toBe("Noel Nope");
    const paged = await api<{ recipients: unknown[]; next_cursor: string | null }>(rec.GET, `/api/marketing/campaigns/${campaignId}/recipients`, { query: { limit: 2 }, params: { id: campaignId }, expect: 200 });
    expect(paged.body.recipients).toHaveLength(2);
    expect(paged.body.next_cursor).toBeTruthy();
    const detail = await import("@/app/api/marketing/campaigns/[id]/route");
    const d = await api<{ campaign: CampaignDTO; stats: Stats }>(detail.GET, `/api/marketing/campaigns/${campaignId}`, { params: { id: campaignId }, expect: 200 });
    expect(d.body.campaign.status).toBe("sent");
    // sent campaigns cannot be edited
    await api(detail.PATCH, `/api/marketing/campaigns/${campaignId}`, { method: "PATCH", json: { name: "Renamed" }, params: { id: campaignId }, expect: 409 });
  });

  it("sequences: enroll → due step sends through the consent gate; non-consented contact exits", async (ctx) => {
    if (!ready) return ctx.skip();
    const seqs = await import("@/app/api/marketing/sequences/route");
    await api(seqs.POST, "/api/marketing/sequences", { json: { name: "Empty", steps: [] }, expect: 400 });
    const s = await api<{ sequence: { id: string } }>(seqs.POST, "/api/marketing/sequences", {
      json: { name: "Welcome", trigger: "manual", steps: [{ delay_hours: 0, channel: "email", subject: "Welcome {{first_name}}", body_md: "Glad you're here, {{first_name}}." }, { delay_hours: 48, channel: "email", template_id: templateId }] },
      expect: 201,
    });
    const seqId = s.body.sequence.id;
    const enroll = await import("@/app/api/marketing/sequences/[id]/enroll/route");
    const e = await api<{ created: number; existing: number; errors: unknown[] }>(enroll.POST, `/api/marketing/sequences/${seqId}/enroll`, { json: { contact_ids: [consented2, noConsent, "missing-contact"] }, params: { id: seqId }, expect: 200 });
    expect(e.body).toMatchObject({ created: 2, existing: 0 });
    expect(e.body.errors).toHaveLength(1);
    const again = await api<{ created: number; existing: number }>(enroll.POST, `/api/marketing/sequences/${seqId}/enroll`, { json: { contact_ids: [consented2] }, params: { id: seqId }, expect: 200 });
    expect(again.body).toMatchObject({ created: 0, existing: 1 });
    await expectEvent(org.dataId, "sequence.enrolled", seqId);

    const { runDueEnrollments } = await import("@/lib/marketing/sequences");
    const r = await runDueEnrollments(50);
    expect(r.sent).toBe(1);
    expect(r.exited).toBe(1);
    const list = await import("@/app/api/marketing/sequences/[id]/enrollments/route");
    const en = await api<{ enrollments: Array<{ contact_id: string; status: string; step_index: number; exited_reason: string | null }> }>(list.GET, `/api/marketing/sequences/${seqId}/enrollments`, { params: { id: seqId }, expect: 200 });
    const dana = en.body.enrollments.find((x) => x.contact_id === consented2)!;
    const noel = en.body.enrollments.find((x) => x.contact_id === noConsent)!;
    expect(dana).toMatchObject({ status: "active", step_index: 1 });
    expect(noel).toMatchObject({ status: "exited", exited_reason: "no_consent" });
    const seqMail = await sqlOne<{ subject: string; data: string }>(`SELECT subject, data FROM notification_outbox WHERE user_id = $1 AND data LIKE $2 ORDER BY created_at DESC LIMIT 1`, [org.dataId, `%"sequence_id":"${seqId}"%`]);
    expect(seqMail?.subject).toBe("Welcome Dana");
    expect(JSON.parse(seqMail!.data)).toMatchObject({ category: "marketing" });

    // Tool path (used by the automation template): idempotent enroll by name.
    await import("@/lib/agents/tools");
    const { getTool } = await import("@/lib/agents/registry");
    const tool = getTool("marketing.enroll")!;
    const out = await tool.run({ userId: org.dataId, runId: "itest", agentId: "itest" } as unknown as Parameters<typeof tool.run>[0], { sequence: "welcome", contact_id: consented2 });
    expect(out.ok).toBe(true);
    expect(out.summary).toMatch(/already in/);
    const count = getTool("marketing.audience_count")!;
    const cnt = await count.run({ userId: org.dataId, runId: "itest", agentId: "itest" } as unknown as Parameters<typeof count.run>[0], { audience_id: audienceId, channel: "email" });
    expect(cnt.data).toMatchObject({ total: 3, eligible: 1 }); // Casey unsubscribed
  });

  it("test-send goes to the operator without touching recipients or consent", async (ctx) => {
    if (!ready) return ctx.skip();
    const ts = await import("@/app/api/marketing/campaigns/[id]/test-send/route");
    const r = await api<{ ok: boolean; to: string }>(ts.POST, `/api/marketing/campaigns/${campaignId}/test-send`, { json: { email: "operator@example.test" }, params: { id: campaignId }, expect: 200 });
    expect(r.body.to).toBe("operator@example.test");
    const row = await sqlOne<{ subject: string }>(`SELECT subject FROM notification_outbox WHERE user_id = $1 AND recipient = 'operator@example.test' ORDER BY created_at DESC LIMIT 1`, [org.dataId]);
    expect(row?.subject).toMatch(/^\[Test\] Hi Test from/);
    expect(await sql(`SELECT id FROM campaign_recipients WHERE campaign_id = $1`, [campaignId])).toHaveLength(3);
  });

  it("API v1: list/get/launch via key; 401 without key; 403 on wrong scope; 403 for viewer role on writes", async (ctx) => {
    if (!ready) return ctx.skip();
    const keys = await import("@/app/api/api-keys/route");
    const full = (await api<{ key: string }>(keys.POST, "/api/api-keys", { json: { name: "mkt", scopes: ["write:crm"] }, expect: 201 })).body.key;
    const wrong = (await api<{ key: string }>(keys.POST, "/api/api-keys", { json: { name: "mkt-ro", scopes: ["read:billing"] }, expect: 201 })).body.key;
    const list = await import("@/app/api/v1/marketing/campaigns/route");
    await api(list.GET, "/api/v1/marketing/campaigns", { expect: 401 });
    await api(list.GET, "/api/v1/marketing/campaigns", { headers: { authorization: `Bearer ${wrong}` }, expect: 403 });
    const l = await api<Env<Array<{ id: string; stats: Stats }>>>(list.GET, "/api/v1/marketing/campaigns", { headers: { authorization: `Bearer ${full}` }, expect: 200 });
    expect(l.body.data.find((c) => c.id === campaignId)?.stats.total).toBe(3);
    const get = await import("@/app/api/v1/marketing/campaigns/[id]/route");
    const g = await api<Env<{ status: string }>>(get.GET, `/api/v1/marketing/campaigns/${campaignId}`, { params: { id: campaignId }, headers: { authorization: `Bearer ${full}` }, expect: 200 });
    expect(g.body.data.status).toBe("sent");
    const launch = await import("@/app/api/v1/marketing/campaigns/[id]/launch/route");
    await api(launch.POST, `/api/v1/marketing/campaigns/${campaignId}/launch`, { json: {}, params: { id: campaignId }, headers: { authorization: `Bearer ${full}` }, expect: 422 });
    const auds = await import("@/app/api/v1/marketing/audiences/route");
    const a = await api<Env<Array<{ id: string; definition: Record<string, unknown> }>>>(auds.GET, "/api/v1/marketing/audiences", { headers: { authorization: `Bearer ${full}` }, expect: 200 });
    expect(a.body.data.find((x) => x.id === audienceId)?.definition).toMatchObject({ lifecycle: ["customer"] });
    const tpls = await import("@/app/api/v1/marketing/templates/route");
    const t = await api<Env<Array<{ id: string }>>>(tpls.GET, "/api/v1/marketing/templates", { headers: { authorization: `Bearer ${full}` }, expect: 200 });
    expect(t.body.data.map((x) => x.id)).toContain(templateId);

    // Session routes: viewer role cannot write, anonymous gets 401.
    setScope(org, { role: "viewer" });
    const camps = await import("@/app/api/marketing/campaigns/route");
    await api(camps.POST, "/api/marketing/campaigns", { json: { name: "x", channel: "email" }, expect: 403 });
    setScope(null);
    await api(camps.GET, "/api/marketing/campaigns", { expect: 401 });
    setScope(org);
  });
});
