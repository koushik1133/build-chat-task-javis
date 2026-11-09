/**
 * Memberships end-to-end: plan (staff API, 401/403) → public GET/POST join (existing contact reused, no
 * consent binding, no enumeration) → first invoice (setup + period) paid through the simulated pay page →
 * renewal via billDue with time travel (idempotent: double run = one invoice) → portal saved card (isolated
 * per token) → auto charge → decline → dunning day 1/3/7 → past_due → recovery → expired (invoice void) →
 * trial (reminder once, conversion), pause/resume, cancel at period end, change with proration, unpaid
 * sign-up expiry, metrics, v1 401/403.
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { api, cleanupDataIds, createTestOrg, describeDb, eventsFor, setScope, sql, sqlOne, type TestOrg } from "./setup";

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));

interface Sub {
  id: string;
  status: string;
  failed_attempts: number;
  next_charge_at: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  has_payment_method: boolean;
  last_invoice_id: string | null;
}
const DAY = 86_400_000;

describeDb("memberships flow", () => {
  let A: TestOrg;
  let B: TestOrg;
  let slug = "";
  let trialSlug = "";
  let contactId = "";
  let subId = "";
  let portalA = "";
  let portalB = "";
  const email = "member@example.test";

  const getSub = async (id = subId): Promise<Sub> => {
    const r = await sqlOne<Sub>(`SELECT id, status, failed_attempts, next_charge_at, current_period_end, cancel_at_period_end, (payment_ref IS NOT NULL) AS has_payment_method, last_invoice_id FROM customer_subscriptions WHERE id = $1`, [id]);
    if (!r) throw new Error("sub missing");
    return r;
  };
  const invoiceCount = async (id = subId) => Number((await sqlOne<{ n: string }>(`SELECT COUNT(*) AS n FROM subscription_charges WHERE subscription_id = $1 AND invoice_id IS NOT NULL`, [id]))?.n ?? 0);
  const payInvoice = async (invoiceId: string) => {
    const { createPayLink } = await import("@/lib/money/invoices");
    const link = await createPayLink(A.dataId, invoiceId);
    const pay = await import("@/app/api/p/pay/[token]/route");
    await api(pay.POST, `/api/p/pay/${link.token}`, { json: { outcome: "success" }, params: { token: link.token }, expect: 200 });
  };
  const portalAct = async (token: string, body: Record<string, unknown>, expectStatus: number | number[] = 200) => {
    const r = await import("@/app/api/p/portal/[token]/memberships/route");
    return api<{ ok?: boolean; error?: string; memberships?: Array<{ id: string; status: string }> }>(r.POST, `/api/p/portal/${token}/memberships`, { json: body, params: { token }, expect: expectStatus });
  };

  beforeAll(async () => {
    A = await createTestOrg("memA");
    B = await createTestOrg("memB");
    setScope(A);
    contactId = crypto.randomUUID();
    await sql(`INSERT INTO crm_contacts (id, user_id, domain, full_name, email, tags, lifecycle) VALUES ($1, $2, 'general', 'Existing Person', $3, '[]', 'lead')`, [contactId, A.dataId, email]);
  });
  afterAll(async () => {
    await cleanupDataIds([A.dataId, B.dataId]);
  });

  it("plans: staff create (401/403 enforced), unknown keys rejected, link name unique", async () => {
    const route = await import("@/app/api/memberships/plans/route");
    setScope(null);
    await api(route.GET, "/api/memberships/plans", { expect: 401 });
    setScope(A, { role: "viewer", userId: "itest-viewer" });
    await api(route.POST, "/api/memberships/plans", { json: { name: "X", amount_minor: 100 }, expect: 403 });
    setScope(A);
    await api(route.POST, "/api/memberships/plans", { json: { name: "X", amount_minor: 100, bogus: 1 }, expect: 400 });
    const made = await api<{ plan: { id: string; slug: string; interval: string } }>(route.POST, "/api/memberships/plans", {
      json: { name: "Gold Gym", amount_minor: 3000, currency: "USD", interval: "month", setup_fee_minor: 1000, benefits: [{ label: "Pool" }, { label: "Sauna" }], allow_pause: true, allow_quantity: true },
      expect: 201,
    });
    slug = made.body.plan.slug;
    expect(slug).toBe("gold-gym");
    await api(route.POST, "/api/memberships/plans", { json: { name: "Dup", slug: "gold-gym", amount_minor: 100 }, expect: 409 });
    const trial = await api<{ plan: { slug: string } }>(route.POST, "/api/memberships/plans", { json: { name: "Trial Box", amount_minor: 2000, trial_days: 14, interval: "month" }, expect: 201 });
    trialSlug = trial.body.plan.slug;
    const list = await api<{ plans: Array<{ slug: string; members: number }>; org_slug: string }>(route.GET, "/api/memberships/plans", { expect: 200 });
    expect(list.body.plans).toHaveLength(2);
    expect(list.body.org_slug).toBe(A.slug);
  });

  it("public join: plan details, subscribe reuses the contact without binding consent, same shape for new vs existing emails", async () => {
    const join = await import("@/app/api/join/[org]/[plan]/route");
    const p = { org: A.slug, plan: slug };
    await api(join.GET, `/api/join/${A.slug}/nope`, { params: { org: A.slug, plan: "nope" }, expect: 404 });
    await api(join.GET, `/api/join/no-such-org/${slug}`, { params: { org: "no-such-org", plan: slug }, expect: 404 });
    const info = await api<{ plan: { name: string; benefits: unknown[]; setup_fee_minor: number } }>(join.GET, `/api/join/${A.slug}/${slug}`, { params: p, expect: 200 });
    expect(info.body.plan).toMatchObject({ name: "Gold Gym", setup_fee_minor: 1000 });
    expect(info.body.plan.benefits).toHaveLength(2);

    // Terms are mandatory; unknown fields rejected.
    await api(join.POST, `/api/join/${A.slug}/${slug}`, { json: { contact: { name: "A", email }, consent: { terms: false } }, params: p, expect: 400 });
    await api(join.POST, `/api/join/${A.slug}/${slug}`, { json: { contact: { name: "A", email }, consent: { terms: true }, extra: 1 }, params: p, expect: 400 });

    const before = Number((await sqlOne<{ n: string }>(`SELECT COUNT(*) AS n FROM crm_contacts WHERE user_id = $1`, [A.dataId]))?.n);
    const existing = await api<Record<string, unknown>>(join.POST, `/api/join/${A.slug}/${slug}`, { json: { contact: { name: "Someone Else", email }, consent: { terms: true, marketing: true } }, params: p, expect: 201 });
    const fresh = await api<Record<string, unknown>>(join.POST, `/api/join/${A.slug}/${slug}`, { json: { contact: { name: "New Person", email: "new@example.test" }, consent: { terms: true, marketing: false } }, params: p, expect: 201 });
    expect(Object.keys(existing.body).sort()).toEqual(Object.keys(fresh.body).sort());
    expect(String(existing.body.pay_url)).toContain("/p/pay/");
    const after = Number((await sqlOne<{ n: string }>(`SELECT COUNT(*) AS n FROM crm_contacts WHERE user_id = $1`, [A.dataId]))?.n);
    expect(after).toBe(before + 1); // only the new email created a contact
    // The pre-existing contact's consent ledger is untouched by an unverified submission.
    const consent = await sqlOne<{ n: string }>(`SELECT COUNT(*) AS n FROM consent_records WHERE user_id = $1 AND subject_id = $2`, [A.dataId, contactId]);
    expect(Number(consent?.n)).toBe(0);

    // A repeat submit while unpaid resumes the same sign-up.
    const again = await api<{ pay_url: string }>(join.POST, `/api/join/${A.slug}/${slug}`, { json: { contact: { name: "Someone Else", email }, consent: { terms: true } }, params: p, expect: 201 });
    const subs = await sql<{ id: string }>(`SELECT id FROM customer_subscriptions WHERE user_id = $1 AND contact_id = $2`, [A.dataId, contactId]);
    expect(subs).toHaveLength(1);
    subId = subs[0].id;
    const sub = await getSub();
    expect(sub.status).toBe("incomplete");
    expect(again.body.pay_url).toContain("/p/pay/");
    await expectEvents("membership.subscribed", 2);
  });

  async function expectEvents(type: string, min: number) {
    const rows = await eventsFor(A.dataId, type);
    expect(rows.length).toBeGreaterThanOrEqual(min);
    return rows;
  }

  it("first invoice = setup + first period; simulated pay activates the membership", async () => {
    const charge = await sqlOne<{ invoice_id: string; amount_minor: string; period_end: string }>(`SELECT invoice_id, amount_minor, period_end FROM subscription_charges WHERE subscription_id = $1`, [subId]);
    expect(Number(charge?.amount_minor)).toBe(4000);
    const inv = await sqlOne<{ status: string; reminder_count: number }>(`SELECT status, reminder_count FROM invoices WHERE id = $1`, [charge?.invoice_id]);
    expect(inv?.status).toBe("sent");
    await payInvoice(charge?.invoice_id as string);
    const sub = await getSub();
    expect(sub.status).toBe("active");
    expect(new Date(sub.next_charge_at as string).toISOString()).toBe(new Date(sub.current_period_end as string).toISOString());
    expect((await sqlOne<{ status: string }>(`SELECT status FROM subscription_charges WHERE subscription_id = $1`, [subId]))?.status).toBe("paid");
    const { hasActiveMembership } = await import("@/lib/memberships/subscriptions");
    expect(await hasActiveMembership(A.dataId, contactId)).toBe(true);
    expect(await hasActiveMembership(A.dataId, contactId, slug)).toBe(true);
    expect(await hasActiveMembership(A.dataId, contactId, "other-plan")).toBe(false);
    expect(await hasActiveMembership(B.dataId, contactId)).toBe(false);
  });

  it("renewal without a saved card: billDue is idempotent, emails the pay link, payment renews", async () => {
    const { billDue } = await import("@/lib/memberships/billing");
    const end = new Date((await getSub()).current_period_end as string);
    const now = new Date(end.getTime() + 1000);
    const first = await billDue(100, now);
    expect(first.invoiced).toBeGreaterThanOrEqual(1);
    const second = await billDue(100, now);
    expect(second.invoiced).toBe(0);
    expect(await invoiceCount()).toBe(2);
    let sub = await getSub();
    expect(sub.failed_attempts).toBe(1);
    expect(sub.status).toBe("active"); // unpaid link: still in good standing until the grace retry
    const mail = await sql(`SELECT id FROM notification_outbox WHERE user_id = $1 AND data LIKE '%membership_invoice%'`, [A.dataId]);
    expect(mail.length).toBeGreaterThan(0);
    await payInvoice(sub.last_invoice_id as string);
    sub = await getSub();
    expect(sub.status).toBe("active");
    expect(sub.failed_attempts).toBe(0);
    expect(new Date(sub.next_charge_at as string).getTime()).toBeGreaterThan(end.getTime());
    await expectEvents("membership.renewed", 1);
    // Not due yet: nothing happens.
    expect((await billDue(100, new Date(end.getTime() + 2000))).invoiced).toBe(0);
  });

  it("portal: saved card is scoped to the token's contact; another org's token cannot touch it", async () => {
    const { issueShareToken } = await import("@/lib/share-tokens");
    portalA = (await issueShareToken(A.dataId, "portal", contactId, 14)).token;
    const otherContact = crypto.randomUUID();
    await sql(`INSERT INTO crm_contacts (id, user_id, domain, full_name, email, tags, lifecycle) VALUES ($1, $2, 'general', 'Other', 'o@example.test', '[]', 'lead')`, [otherContact, B.dataId]);
    portalB = (await issueShareToken(B.dataId, "portal", otherContact, 14)).token;

    const mem = await import("@/app/api/p/portal/[token]/memberships/route");
    const mine = await api<{ memberships: Array<{ id: string; planName: string; status: string }> }>(mem.GET, `/api/p/portal/${portalA}/memberships`, { params: { token: portalA }, expect: 200 });
    expect(mine.body.memberships.map((m) => m.id)).toContain(subId);
    const theirs = await api<{ memberships: unknown[] }>(mem.GET, `/api/p/portal/${portalB}/memberships`, { params: { token: portalB }, expect: 200 });
    expect(theirs.body.memberships).toHaveLength(0);
    await portalAct(portalB, { action: "cancel", subscription_id: subId }, 404);
    await portalAct(portalB, { action: "update_payment_method", subscription_id: subId, simulate: "ok" }, 404);
    await api(mem.GET, `/api/p/portal/bogus/memberships`, { params: { token: "bogus" }, expect: 404 });
    await portalAct(portalA, { action: "update_payment_method", subscription_id: subId, simulate: "ok", extra: 1 }, 400);
    await portalAct(portalA, { action: "update_payment_method", subscription_id: subId, simulate: "ok" });
    expect((await getSub()).has_payment_method).toBe(true);

    // The portal read model carries the tab data.
    const { getPortalData } = await import("@/lib/portal");
    const data = await getPortalData(A.dataId, contactId, { issueLinks: false });
    expect(data?.memberships.map((m) => m.id)).toContain(subId);
  });

  it("saved card: renewal charges automatically and the invoice is paid", async () => {
    const { billDue } = await import("@/lib/memberships/billing");
    const end = new Date((await getSub()).current_period_end as string);
    await billDue(100, new Date(end.getTime() + 1000));
    const sub = await getSub();
    expect(sub.status).toBe("active");
    expect(await invoiceCount()).toBe(3);
    expect((await sqlOne<{ status: string }>(`SELECT status FROM invoices WHERE id = $1`, [sub.last_invoice_id]))?.status).toBe("paid");
    const pay = await sqlOne<{ provider: string; provider_ref: string }>(`SELECT provider, provider_ref FROM invoice_payments WHERE invoice_id = $1 AND status = 'succeeded'`, [sub.last_invoice_id]);
    expect(pay?.provider).toBe("simulated");
    expect(pay?.provider_ref).toMatch(/^simch_/);
  });

  it("declined card -> past_due (still has access) -> recovery with a new card", async () => {
    const { billDue } = await import("@/lib/memberships/billing");
    await portalAct(portalA, { action: "update_payment_method", subscription_id: subId, simulate: "decline" });
    const end = new Date((await getSub()).current_period_end as string);
    const now = new Date(end.getTime() + 1000);
    await billDue(100, now);
    let sub = await getSub();
    expect(sub.status).toBe("past_due");
    expect(sub.failed_attempts).toBe(1);
    expect(new Date(sub.next_charge_at as string).getTime()).toBe(end.getTime() + DAY);
    const failed = await eventsFor(A.dataId, "membership.payment_failed");
    expect(failed.length).toBe(1);
    expect(JSON.parse(failed[0].data ?? "{}")).toMatchObject({ reason: "card_declined", attempt: 1 });
    const { hasActiveMembership } = await import("@/lib/memberships/subscriptions");
    expect(await hasActiveMembership(A.dataId, contactId)).toBe(true);

    // New card on a past-due membership retries on the next tick.
    await portalAct(portalA, { action: "update_payment_method", subscription_id: subId, simulate: "ok" });
    await billDue(100, new Date(end.getTime() + 2000));
    sub = await getSub();
    expect(sub.status).toBe("active");
    expect(sub.failed_attempts).toBe(0);
    expect(await invoiceCount()).toBe(4);
  });

  it("dunning: retries on day 1, 3, 7 then the membership expires and the invoice is voided", async () => {
    const { billDue } = await import("@/lib/memberships/billing");
    await portalAct(portalA, { action: "update_payment_method", subscription_id: subId, simulate: "decline" });
    const end = new Date((await getSub()).current_period_end as string);
    await billDue(100, new Date(end.getTime() + 1000));
    expect((await getSub()).failed_attempts).toBe(1);
    // Early tick: not due yet.
    expect((await billDue(100, new Date(end.getTime() + 3600_000))).failed).toBe(0);

    await billDue(100, new Date(end.getTime() + DAY + 1000));
    let sub = await getSub();
    expect(sub).toMatchObject({ status: "past_due", failed_attempts: 2 });
    expect(new Date(sub.next_charge_at as string).getTime()).toBe(end.getTime() + 3 * DAY);
    await billDue(100, new Date(end.getTime() + 3 * DAY + 1000));
    sub = await getSub();
    expect(sub.failed_attempts).toBe(3);
    expect(new Date(sub.next_charge_at as string).getTime()).toBe(end.getTime() + 7 * DAY);
    const last = await billDue(100, new Date(end.getTime() + 7 * DAY + 1000));
    expect(last.expired).toBe(1);
    sub = await getSub();
    expect(sub.status).toBe("expired");
    expect(sub.next_charge_at).toBeNull();
    expect((await sqlOne<{ status: string }>(`SELECT status FROM invoices WHERE id = $1`, [sub.last_invoice_id]))?.status).toBe("void");
    expect((await sqlOne<{ status: string }>(`SELECT status FROM subscription_charges WHERE subscription_id = $1 ORDER BY period_start DESC LIMIT 1`, [subId]))?.status).toBe("failed");
    const cancelled = await eventsFor(A.dataId, "membership.cancelled");
    expect(cancelled.some((e) => e.entity_id === subId)).toBe(true);
    const { hasActiveMembership } = await import("@/lib/memberships/subscriptions");
    expect(await hasActiveMembership(A.dataId, contactId)).toBe(false);
    // An ended membership is never billed again.
    expect((await billDue(100, new Date(end.getTime() + 60 * DAY))).claimed).toBe(0);
  });

  it("trial: no invoice, one reminder, conversion bills the first period; pause/resume; change with proration; cancel at period end", async () => {
    const { billDue, sweepExpiring } = await import("@/lib/memberships/billing");
    const join = await import("@/app/api/join/[org]/[plan]/route");
    const p = { org: A.slug, plan: trialSlug };
    const r = await api<{ status: string; pay_url: string | null; trial_ends_at: string }>(join.POST, `/api/join/${A.slug}/${trialSlug}`, { json: { contact: { name: "Trial Tina", email: "tina@example.test" }, consent: { terms: true } }, params: p, expect: 201 });
    expect(r.body.status).toBe("trialing");
    expect(r.body.pay_url).toBeNull();
    const sub = await sqlOne<{ id: string }>(`SELECT s.id FROM customer_subscriptions s JOIN crm_contacts c ON c.id = s.contact_id WHERE s.user_id = $1 AND c.email = 'tina@example.test'`, [A.dataId]);
    const id = (sub as { id: string }).id;
    expect(await invoiceCount(id)).toBe(0);
    const trialEnd = new Date(r.body.trial_ends_at);

    const s1 = await sweepExpiring(100, new Date(trialEnd.getTime() - 2 * DAY));
    expect(s1.trial_reminders).toBeGreaterThanOrEqual(1);
    expect((await sweepExpiring(100, new Date(trialEnd.getTime() - 1 * DAY))).trial_reminders).toBe(0);
    const ending = await eventsFor(A.dataId, "membership.trial_ending");
    expect(ending.filter((e) => e.entity_id === id)).toHaveLength(1);

    await billDue(100, new Date(trialEnd.getTime() + 1000));
    let cur = await getSub(id);
    expect(cur.status).toBe("active");
    expect(await invoiceCount(id)).toBe(1);
    await payInvoice(cur.last_invoice_id as string);
    cur = await getSub(id);
    expect(cur.status).toBe("active");
    expect(cur.failed_attempts).toBe(0);

    // Pause (staff API): nothing is billed while paused; resume bills a fresh period.
    const route = await import("@/app/api/memberships/subscriptions/[id]/route");
    await api(route.POST, `/api/memberships/subscriptions/${id}`, { json: { action: "pause" }, params: { id }, expect: 200 });
    expect((await getSub(id)).status).toBe("paused");
    const farFuture = new Date(trialEnd.getTime() + 120 * DAY);
    await billDue(100, farFuture);
    expect(await invoiceCount(id)).toBe(1);
    await api(route.POST, `/api/memberships/subscriptions/${id}`, { json: { action: "pause" }, params: { id }, expect: 409 });
    await api(route.POST, `/api/memberships/subscriptions/${id}`, { json: { action: "resume" }, params: { id }, expect: 200 });
    expect((await getSub(id)).status).toBe("active");
    await billDue(100, new Date(Date.now() + 2000));
    expect(await invoiceCount(id)).toBe(2);
    await payInvoice((await getSub(id)).last_invoice_id as string);

    // Change plan with proration (quantity on a plan that allows it is covered by the pure tests; here: switch plan).
    const changed = await api<{ proration_minor: number; subscription: { plan_slug: string } }>(route.POST, `/api/memberships/subscriptions/${id}`, { json: { action: "change", plan_slug: slug }, params: { id }, expect: 200 });
    expect(changed.body.subscription.plan_slug).toBe(slug);
    expect(typeof changed.body.proration_minor).toBe("number");

    // Cancel at period end: access continues, billing stops at the boundary.
    await api(route.POST, `/api/memberships/subscriptions/${id}`, { json: { action: "cancel", at_period_end: true }, params: { id }, expect: 200 });
    cur = await getSub(id);
    expect(cur.cancel_at_period_end).toBe(true);
    expect(cur.status).toBe("active");
    const end = new Date(cur.current_period_end as string);
    const before = await invoiceCount(id);
    await billDue(100, new Date(end.getTime() + 1000));
    expect((await getSub(id)).status).toBe("cancelled");
    expect(await invoiceCount(id)).toBe(before);
    await api(route.POST, `/api/memberships/subscriptions/${id}`, { json: { action: "cancel" }, params: { id }, expect: 409 });
    await api(route.POST, `/api/memberships/subscriptions/${id}`, { json: { action: "explode" }, params: { id }, expect: 400 });
  });

  it("unpaid sign-ups expire and their invoice is voided; max_members is enforced", async () => {
    const { sweepExpiring } = await import("@/lib/memberships/billing");
    const plans = await import("@/lib/memberships/plans");
    const subs = await import("@/lib/memberships/subscriptions");
    const tiny = await plans.createPlan(A.dataId, plans.PlanInputSchema.parse({ name: "Tiny", amount_minor: 500, max_members: 1 }));
    const one = await subs.subscribe(A.dataId, tiny.slug, subs.SubscribeSchema.parse({ contact: { name: "One", email: "one@example.test" }, consent: { terms: true } }));
    expect(one.pay_url).toContain("/p/pay/");
    await expect(subs.subscribe(A.dataId, tiny.slug, subs.SubscribeSchema.parse({ contact: { name: "Two", email: "two@example.test" }, consent: { terms: true } }))).rejects.toMatchObject({ code: "plan_full" });
    const swept = await sweepExpiring(100, new Date(Date.now() + 4 * DAY));
    expect(swept.incomplete_expired).toBeGreaterThanOrEqual(1);
    const row = await getSub(one.subscription_id);
    expect(row.status).toBe("expired");
    expect((await sqlOne<{ status: string }>(`SELECT status FROM invoices WHERE id IN (SELECT invoice_id FROM subscription_charges WHERE subscription_id = $1)`, [one.subscription_id]))?.status).toBe("void");
    // Archived plans stop taking sign-ups but stay readable.
    await plans.archivePlan(A.dataId, tiny.id);
    await expect(subs.subscribe(A.dataId, tiny.slug, subs.SubscribeSchema.parse({ contact: { name: "Three", email: "three@example.test" }, consent: { terms: true } }))).rejects.toMatchObject({ code: "plan_unavailable" });
  });

  it("metrics + list filters + search kinds", async () => {
    const m = await api<{ metrics: { active_members: number; new_by_month: unknown[]; trial_conversion_pct: number | null } }>((await import("@/app/api/memberships/metrics/route")).GET, "/api/memberships/metrics", { expect: 200 });
    expect(m.body.metrics.new_by_month).toHaveLength(6);
    // Trials end 14 days out: looked at from a month ahead, Tina's converted.
    const { loadMetrics } = await import("@/lib/memberships/subscriptions");
    const later = await loadMetrics(A.dataId, new Date(Date.now() + 30 * DAY));
    expect(later.trial_conversion_pct).toBe(100);
    const list = await import("@/app/api/memberships/subscriptions/route");
    const exp = await api<{ subscriptions: Array<{ status: string }> }>(list.GET, "/api/memberships/subscriptions", { query: { status: "expired" }, expect: 200 });
    expect(exp.body.subscriptions.length).toBeGreaterThanOrEqual(2);
    expect(exp.body.subscriptions.every((s) => s.status === "expired")).toBe(true);
    await api(list.GET, "/api/memberships/subscriptions", { query: { status: "bogus" }, expect: 400 });
    // Tenant isolation.
    setScope(B);
    const other = await api<{ subscriptions: unknown[] }>(list.GET, "/api/memberships/subscriptions", { expect: 200 });
    expect(other.body.subscriptions).toHaveLength(0);
    setScope(A);
  });

  it("API v1: plans + subscriptions list/get/cancel with scopes", async () => {
    const keys = await import("@/app/api/api-keys/route");
    const full = await api<{ key: string }>(keys.POST, "/api/api-keys", { json: { name: "mem full", scopes: ["write:billing"] }, expect: 201 });
    const ro = await api<{ key: string }>(keys.POST, "/api/api-keys", { json: { name: "mem crm", scopes: ["read:crm"] }, expect: 201 });
    const bearer = (k: string) => ({ authorization: `Bearer ${k}` });
    const plans = await import("@/app/api/v1/membership-plans/route");
    const subs = await import("@/app/api/v1/subscriptions/route");
    const one = await import("@/app/api/v1/subscriptions/[id]/route");
    const cancel = await import("@/app/api/v1/subscriptions/[id]/cancel/route");
    await api(plans.GET, "/api/v1/membership-plans", { expect: 401 });
    await api(subs.GET, "/api/v1/subscriptions", { headers: bearer(ro.body.key), expect: 403 });
    const pl = await api<{ data: Array<{ slug: string }> }>(plans.GET, "/api/v1/membership-plans", { headers: bearer(full.body.key), expect: 200 });
    expect(pl.body.data.map((x) => x.slug)).toContain(slug);

    const join = await import("@/app/api/join/[org]/[plan]/route");
    const made = await api<{ pay_url: string }>(join.POST, `/api/join/${A.slug}/${trialSlug}`, { json: { contact: { name: "V1 Vera", email: "vera@example.test" }, consent: { terms: true } }, params: { org: A.slug, plan: trialSlug }, expect: 201 });
    expect(made.status).toBe(201);
    const list = await api<{ data: Array<{ id: string; status: string; contact_email: string }> }>(subs.GET, "/api/v1/subscriptions", { query: { status: "trialing" }, headers: bearer(full.body.key), expect: 200 });
    const vera = list.body.data.find((s) => s.contact_email === "vera@example.test");
    expect(vera).toBeTruthy();
    const id = vera?.id as string;
    await api(one.GET, `/api/v1/subscriptions/${id}`, { params: { id }, headers: bearer(full.body.key), expect: 200 });
    await api(one.GET, `/api/v1/subscriptions/nope`, { params: { id: "nope" }, headers: bearer(full.body.key), expect: 404 });
    await api(cancel.POST, `/api/v1/subscriptions/${id}/cancel`, { method: "POST", json: {}, params: { id }, headers: bearer(ro.body.key), expect: 403 });
    const done = await api<{ data: { status: string; cancel_at_period_end: boolean } }>(cancel.POST, `/api/v1/subscriptions/${id}/cancel`, { method: "POST", json: { at_period_end: false }, params: { id }, headers: bearer(full.body.key), expect: 200 });
    expect(done.body.data.status).toBe("cancelled");
  });

  it("public join is rate limited per email", async () => {
    const join = await import("@/app/api/join/[org]/[plan]/route");
    const body = { contact: { name: "Spammer", email: "spam@example.test" }, consent: { terms: true } };
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await api(join.POST, `/api/join/${A.slug}/${trialSlug}`, { json: body, params: { org: A.slug, plan: trialSlug } });
      statuses.push(r.status);
    }
    expect(statuses).toContain(429);
  });
});
