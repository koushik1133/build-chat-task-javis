/**
 * KernelHub plans end-to-end: lazy Growth trial → usage → enforcement off by
 * default → PLANS_ENFORCED=true over-limit invite 402 → simulated checkout →
 * active + included credits once → renewal → cancel at period end → grace /
 * downgrade state machine → API v1 usage 401/403/200.
 */
import { randomUUID } from "crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { api, call, cleanupDataIds, createTestOrg, describeDb, expectEvent, req, setScope, sql, sqlOne, type TestOrg } from "./setup";

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));

interface SubView { subscription: { plan_key: string; status: string; cancel_at_period_end: boolean; current_period_end: string | null; seats_purchased: number }; entitlements: { plan: string; trial: { active: boolean; daysLeft: number } } }
interface UsageView { plan: string; enforced: boolean; usage: Array<{ metric: string; used: number; limit: number | null }>; limits: Record<string, number | null> }
interface CheckoutOut { scheduled: boolean; url: string; token: string; invoiceId: string; amountMinor: number; currency: string }

describeDb("plans flow", () => {
  let org: TestOrg;
  const prevEnforced = process.env.PLANS_ENFORCED;

  beforeAll(async () => {
    org = await createTestOrg("plans");
    setScope(org);
    delete process.env.PLANS_ENFORCED;
  });
  afterAll(async () => {
    if (prevEnforced === undefined) delete process.env.PLANS_ENFORCED;
    else process.env.PLANS_ENFORCED = prevEnforced;
    await cleanupDataIds([org.dataId]);
  });

  const sub = () => sqlOne<{ plan_key: string; status: string; provider: string | null; cancel_at_period_end: boolean; current_period_end: Date | null; seats_purchased: number }>(`SELECT * FROM subscriptions WHERE user_id = $1`, [org.dataId]);

  it("lazily creates a 14-day Growth trial (idempotent) and reports usage with enforcement off", async () => {
    const subRoute = await import("@/app/api/plans/subscription/route");
    const a = await api<SubView>(subRoute.GET, "/api/plans/subscription", { expect: 200 });
    await api<SubView>(subRoute.GET, "/api/plans/subscription", { expect: 200 });
    expect(a.body.subscription).toMatchObject({ plan_key: "growth", status: "trialing" });
    expect(a.body.entitlements.trial.active).toBe(true);
    expect(a.body.entitlements.trial.daysLeft).toBeGreaterThanOrEqual(13);
    expect(await sql(`SELECT 1 FROM subscriptions WHERE user_id = $1`, [org.dataId])).toHaveLength(1);
    await expectEvent(org.dataId, "subscription.created", org.dataId);

    const usageRoute = await import("@/app/api/plans/usage/route");
    const u = await api<UsageView>(usageRoute.GET, "/api/plans/usage", { expect: 200 });
    expect(u.body.enforced).toBe(false);
    expect(u.body.plan).toBe("growth");
    expect(u.body.usage.find((x) => x.metric === "seats")).toMatchObject({ used: 1, limit: 15 });
  });

  it("enforcement off: invites past the Free limit still succeed", async () => {
    await sql(`UPDATE subscriptions SET trial_ends_at = NOW() - INTERVAL '1 day', current_period_end = NOW() - INTERVAL '1 day' WHERE user_id = $1`, [org.dataId]);
    const invite = await import("@/app/api/team/invite/route");
    for (const n of [1, 2, 3]) {
      await api(invite.POST, "/api/team/invite", { json: { email: `off${n}@example.test`, role: "member" }, expect: 200 });
    }
    await sql(`DELETE FROM memberships WHERE org_id = $1 AND status = 'invited'`, [org.orgId]);
  });

  it("PLANS_ENFORCED=true: expired trial is Free; over-limit invite returns 402 plan_limit", async () => {
    process.env.PLANS_ENFORCED = "true";
    const invite = await import("@/app/api/team/invite/route");
    await api(invite.POST, "/api/team/invite", { json: { email: "one@example.test", role: "member" }, expect: 200 }); // owner + 1 = 2 = Free cap
    const blocked = await api<{ error: string; metric: string; limit: number; used: number; upgrade_to: string; upgrade_url: string }>(invite.POST, "/api/team/invite", { json: { email: "two@example.test", role: "member" }, expect: 402 });
    expect(blocked.body).toMatchObject({ error: "plan_limit", metric: "seats", limit: 2, used: 2, upgrade_to: "starter" });
    expect(blocked.body.upgrade_url).toContain("/settings/plan");

    const sso = await import("@/app/api/scim/tokens/route");
    const gated = await api<{ error: string; kind: string }>(sso.POST, "/api/scim/tokens", { json: { name: "x" }, expect: 402 });
    expect(gated.body).toMatchObject({ error: "plan_limit", kind: "feature" });
  });

  it("non-admins cannot manage the plan", async () => {
    const checkout = await import("@/app/api/plans/checkout/route");
    setScope(org, { role: "member" });
    await api(checkout.POST, "/api/plans/checkout", { json: { plan_key: "starter", interval: "month" }, expect: 403 });
    setScope(org);
  });

  let token = "";
  it("simulated checkout activates Starter and grants included credits exactly once", async () => {
    const checkout = await import("@/app/api/plans/checkout/route");
    const out = await api<CheckoutOut>(checkout.POST, "/api/plans/checkout", { json: { plan_key: "starter", interval: "month" }, expect: 200 });
    expect(out.body).toMatchObject({ scheduled: false, amountMinor: 2900 });
    token = out.body.token;

    const pub = await import("@/app/api/p/plan/[token]/route");
    const view = await call<{ invoice: { status: string } }>(pub.GET, req(`/api/p/plan/${token}`), { token }, 200);
    expect(view.body.invoice.status).toBe("open");

    const { getBalance } = await import("@/lib/credits/ledger");
    const before = await getBalance(org.dataId);
    const paid = await call<{ status: string; activated: boolean }>(pub.POST, req(`/api/p/plan/${token}`, { json: { outcome: "success" } }), { token }, 200);
    expect(paid.body).toMatchObject({ status: "paid", activated: true });
    const again = await call<{ activated: boolean }>(pub.POST, req(`/api/p/plan/${token}`, { json: { outcome: "success" } }), { token }, 200);
    expect(again.body.activated).toBe(false);

    expect(await sub()).toMatchObject({ plan_key: "starter", status: "active", provider: "simulated" });
    expect(await getBalance(org.dataId)).toBe(before + 5000);
    const grants = await sql(`SELECT 1 FROM ai_credit_ledger WHERE user_id = $1 AND ref_kind = 'plan'`, [org.dataId]);
    expect(grants).toHaveLength(1);
    await expectEvent(org.dataId, "subscription.plan_changed", org.dataId);

    const { grantMonthlyCredits } = await import("@/lib/plans/cron");
    await grantMonthlyCredits(500);
    expect(await sql(`SELECT 1 FROM ai_credit_ledger WHERE user_id = $1 AND ref_kind = 'plan'`, [org.dataId])).toHaveLength(1);
    expect(await getBalance(org.dataId)).toBe(before + 5000);

    const invoices = await import("@/app/api/plans/invoices/route");
    const list = await api<{ invoices: Array<{ status: string; kind: string }> }>(invoices.GET, "/api/plans/invoices", { expect: 200 });
    expect(list.body.invoices[0]).toMatchObject({ status: "paid", kind: "subscribe" });

    const invite = await import("@/app/api/team/invite/route");
    await api(invite.POST, "/api/team/invite", { json: { email: "two@example.test", role: "member" }, expect: 200 });
  });

  it("failed payments leave the plan untouched", async () => {
    const checkout = await import("@/app/api/plans/checkout/route");
    const up = await api<CheckoutOut>(checkout.POST, "/api/plans/checkout", { json: { plan_key: "growth", interval: "month" }, expect: 200 });
    expect(up.body.amountMinor).toBeGreaterThan(0);
    expect(up.body.amountMinor).toBeLessThanOrEqual(5000); // prorated difference, not the full price
    const pub = await import("@/app/api/p/plan/[token]/route");
    await call(pub.POST, req(`/api/p/plan/${up.body.token}`, { json: { outcome: "failure" } }), { token: up.body.token }, 200);
    expect((await sub())?.plan_key).toBe("starter");
  });

  it("downgrades are scheduled; renewDue renews (simulated) and applies them", async () => {
    const checkout = await import("@/app/api/plans/checkout/route");
    const down = await api<{ scheduled: boolean }>(checkout.POST, "/api/plans/checkout", { json: { plan_key: "growth", interval: "year" }, expect: 200 });
    expect(down.body.scheduled).toBe(false); // growth is an upgrade (other interval): full price checkout
    const free = await api<{ scheduled: boolean }>(checkout.POST, "/api/plans/checkout", { json: { plan_key: "free", interval: "month" }, expect: 200 });
    expect(free.body.scheduled).toBe(true);
    const resume = await import("@/app/api/plans/resume/route");
    await api(resume.POST, "/api/plans/resume", { expect: 200 });

    await sql(`UPDATE subscriptions SET current_period_end = NOW() - INTERVAL '1 hour' WHERE user_id = $1`, [org.dataId]);
    const { renewDue } = await import("@/lib/plans/cron");
    const r = await renewDue(500);
    expect(r.renewed).toBeGreaterThanOrEqual(1);
    const s = await sub();
    expect(s?.status).toBe("active");
    expect(s && s.current_period_end && s.current_period_end.getTime()).toBeGreaterThan(Date.now());
    expect(await sql(`SELECT 1 FROM plan_invoices WHERE user_id = $1 AND kind = 'renewal' AND status = 'paid'`, [org.dataId])).toHaveLength(1);
    await expectEvent(org.dataId, "subscription.renewed", org.dataId);
  });

  it("cancel at period end → renewDue cancels and falls back to Free", async () => {
    const cancel = await import("@/app/api/plans/cancel/route");
    const c = await api<SubView>(cancel.POST, "/api/plans/cancel", { expect: 200 });
    expect(c.body.subscription.cancel_at_period_end).toBe(true);
    await sql(`UPDATE subscriptions SET current_period_end = NOW() - INTERVAL '1 hour' WHERE user_id = $1`, [org.dataId]);
    const { renewDue } = await import("@/lib/plans/cron");
    const r = await renewDue(500);
    expect(r.cancelled).toBeGreaterThanOrEqual(1);
    expect(await sub()).toMatchObject({ plan_key: "free", status: "cancelled" });
    await expectEvent(org.dataId, "subscription.cancelled", org.dataId);
  });

  it("real provider unpaid: grace → past_due → downgraded after 7 more days", async () => {
    const { renewDue } = await import("@/lib/plans/cron");
    await sql(`UPDATE subscriptions SET plan_key = 'starter', status = 'active', provider = 'stripe', cancel_at_period_end = FALSE, current_period_end = NOW() - INTERVAL '1 day' WHERE user_id = $1`, [org.dataId]);
    await renewDue(500);
    expect((await sub())?.status).toBe("active"); // inside grace
    await sql(`UPDATE subscriptions SET current_period_end = NOW() - INTERVAL '5 days' WHERE user_id = $1`, [org.dataId]);
    await renewDue(500);
    expect((await sub())?.status).toBe("past_due");
    await expectEvent(org.dataId, "subscription.past_due", org.dataId);
    await sql(`UPDATE subscriptions SET current_period_end = NOW() - INTERVAL '11 days' WHERE user_id = $1`, [org.dataId]);
    await renewDue(500);
    expect(await sub()).toMatchObject({ plan_key: "free", status: "cancelled" });
  });

  it("API v1 /usage: 401 without a key, 403 without read:billing, 200 with it", async () => {
    const keys = await import("@/app/api/api-keys/route");
    process.env.PLANS_ENFORCED = "false";
    const wrong = await api<{ key: string }>(keys.POST, "/api/api-keys", { json: { name: "crm only", scopes: ["read:crm"] }, expect: 201 });
    const right = await api<{ key: string }>(keys.POST, "/api/api-keys", { json: { name: "billing", scopes: ["read:billing"] }, expect: 201 });
    const v1 = await import("@/app/api/v1/usage/route");
    await call(v1.GET, req("/api/v1/usage"), {}, 401);
    await call(v1.GET, req("/api/v1/usage", { headers: { authorization: `Bearer ${wrong.body.key}` } }), {}, 403);
    const ok = await call<{ data: { plan: string; enforced: boolean; limits: Record<string, number | null>; usage: Record<string, number> } }>(v1.GET, req("/api/v1/usage", { headers: { authorization: `Bearer ${right.body.key}` } }), {}, 200);
    expect(ok.body.data.plan).toBe("free");
    expect(ok.body.data.enforced).toBe(false);
    expect(ok.body.data.usage.seats).toBeGreaterThanOrEqual(1);
  });

  it("contacts usage ignores soft-deleted rows; client workspaces use the parent plan", async () => {
    const { measure } = await import("@/lib/plans/usage");
    const before = await measure(org.dataId, "contacts");
    const [a, b] = [randomUUID(), randomUUID()];
    await sql(`INSERT INTO crm_contacts (id, user_id, full_name) VALUES ($1, $3, 'live'), ($2, $3, 'gone')`, [a, b, org.dataId]);
    await sql(`UPDATE crm_contacts SET deleted_at = NOW() WHERE id = $1`, [b]);
    expect(await measure(org.dataId, "contacts")).toBe(before + 1);

    const childId = randomUUID();
    await sql(`INSERT INTO organizations (id, name, slug, owner_user_id, settings, parent_org_id, kind) VALUES ($1, 'child', $2, $1, NULL, $3, 'client')`, [childId, `c-${childId.slice(0, 8)}`, org.orgId]);
    try {
      await sql(`UPDATE subscriptions SET plan_key = 'scale', status = 'active', provider = 'simulated', current_period_end = NOW() + INTERVAL '10 days', trial_ends_at = NULL WHERE user_id = $1`, [org.dataId]);
      const { getEntitlements } = await import("@/lib/plans/entitlements");
      expect((await getEntitlements(childId)).plan).toBe("scale");
      expect(await sql(`SELECT 1 FROM subscriptions WHERE user_id = $1`, [childId])).toHaveLength(0);
    } finally {
      await sql(`DELETE FROM organizations WHERE id = $1`, [childId]);
    }
  });
});
