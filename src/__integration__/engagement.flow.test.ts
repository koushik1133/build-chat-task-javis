/**
 * Engagement end-to-end: voucher + gift card + points at storefront checkout,
 * loyalty earn/tier on payment, survey request after delay, public response,
 * detractor ticket, testimonial, referral guards, consent/opt-out, portal
 * isolation and v1 auth.
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { api, cleanupDataIds, createTestOrg, describeDb, eventsFor, setScope, sql, sqlOne, type TestOrg } from "./setup";

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));

interface Cart { total_minor: number }
function cookieFrom(res: Response): string {
  const m = (res.headers.get("set-cookie") ?? "").match(/(kh_cart_[^=]+=[^;]+)/);
  if (!m) throw new Error("no cart cookie");
  return m[1];
}

describeDb("engagement flow", () => {
  let org: TestOrg;
  let other: TestOrg;
  let slug = "";
  let product: { id: string };
  const email = "buyer@example.test";
  let contactId = "";

  async function newCart(qty = 1): Promise<string> {
    const cart = await import("@/app/api/shop/[org]/cart/route");
    const first = await api<{ cart: Cart }>(cart.GET, `/api/shop/${slug}/cart`, { params: { org: slug }, expect: 200 });
    const cookie = cookieFrom(first.res);
    await api(cart.POST, `/api/shop/${slug}/cart`, { json: { product_id: product.id, qty }, headers: { cookie }, params: { org: slug }, expect: 200 });
    return cookie;
  }
  async function checkout(cookie: string, extra: Record<string, unknown> = {}, expect = 201) {
    const co = await import("@/app/api/shop/[org]/checkout/route");
    return api<{ order: { id: string; total_minor: number; status: string }; error?: string; detail?: string }>(co.POST, `/api/shop/${slug}/checkout`, { json: { name: "Buyer One", email, ...extra }, headers: { cookie }, params: { org: slug }, expect });
  }
  async function lastOrder() {
    return (await sqlOne<{ id: string; invoice_id: string; contact_id: string }>(`SELECT id, invoice_id, contact_id FROM orders WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [org.dataId]))!;
  }
  async function pay(orderId: string) {
    const o = await sqlOne<{ invoice_id: string; total_minor: string; currency: string }>(`SELECT invoice_id, total_minor, currency FROM orders WHERE id = $1`, [orderId]);
    const { recordPayment } = await import("@/lib/money/invoices");
    await recordPayment({ invoiceId: o!.invoice_id, provider: "simulated", providerRef: `pay-${orderId}`, amountMinor: Number(o!.total_minor), currency: o!.currency });
  }

  beforeAll(async () => {
    org = await createTestOrg("engagement");
    other = await createTestOrg("engagement-other");
    setScope(org);
    const { createProduct } = await import("@/lib/inventory/products");
    product = await createProduct(org.dataId, { name: "Mug", sku: "MUG", kind: "product", unit: "each", unit_price_minor: 10000, cost_minor: 0, currency: "USD", tax_rate_bp: 1000, track_stock: false, stock_on_hand: 0, reorder_point: 0, active: true });
    const sf = await import("@/app/api/storefront/route");
    const on = await api<{ storefront: { slug: string } }>(sf.PATCH, "/api/storefront", { method: "PATCH", json: { enabled: true, title: "Shop", collect_shipping: false }, expect: 200 });
    slug = on.body.storefront.slug;
    const sp = await import("@/app/api/storefront/products/route");
    await api(sp.PUT, "/api/storefront/products", { method: "PUT", json: { product_id: product.id, visible: true, sort: 1 }, expect: 200 });
    const { updateProgram } = await import("@/lib/engagement/loyalty");
    await updateProgram(org.dataId, { enabled: true, earn_points: 1, per_minor: 100, redeem_value_minor_per_point: 1, min_redeem_points: 100, max_redeem_pct_bp: 5000, tiers: [{ name: "Silver", min_points: 100, multiplier: 1.5 }] });
  });
  afterAll(async () => {
    await cleanupDataIds([org.dataId, other.dataId]);
  });

  it("staff routes require auth and the right role", async () => {
    const v = await import("@/app/api/engagement/vouchers/route");
    setScope(null);
    await api(v.GET, "/api/engagement/vouchers", { expect: 401 });
    setScope(org, { role: "viewer" });
    await api(v.POST, "/api/engagement/vouchers", { json: { code: "NOPE10", name: "x", kind: "percent", value: 1000 }, expect: 403 });
    setScope(org);
  });

  it("voucher percent + min subtotal + per-contact limit at checkout; discount applied before tax", async () => {
    const v = await import("@/app/api/engagement/vouchers/route");
    await api(v.POST, "/api/engagement/vouchers", { json: { code: "TEN", name: "Ten off", kind: "percent", value: 1000, min_subtotal_minor: 5000, per_contact_limit: 1 }, expect: 201 });
    await api(v.POST, "/api/engagement/vouchers", { json: { code: "TEN", name: "dup", kind: "percent", value: 1000 }, expect: 400 });

    const bad = await checkout(await newCart(), { discounts: { voucher_codes: ["NOSUCH"] } }, 400);
    expect(bad.body.error).toBe("discount_invalid");

    const ok = await checkout(await newCart(), { discounts: { voucher_codes: ["ten"] } });
    // 10000 net - 1000 discount = 9000 + 10% tax = 9900
    expect(ok.body.order.total_minor).toBe(9900);
    const again = await checkout(await newCart(), { discounts: { voucher_codes: ["TEN"] } }, 400);
    expect(again.body.detail).toMatch(/maximum number of times|fully redeemed|already/i);
    const red = await sqlOne<{ n: string }>(`SELECT COUNT(*) AS n FROM voucher_redemptions WHERE user_id = $1`, [org.dataId]);
    expect(Number(red!.n)).toBe(1);
    const lo = await lastOrder();
    contactId = lo.contact_id;
    await pay(lo.id);
  });

  it("loyalty earns on payment (idempotent), tier moves, points redeem at checkout", async () => {
    const { getAccount, earnPoints } = await import("@/lib/engagement/loyalty");
    const acct = await getAccount(org.dataId, contactId);
    // net subtotal after discount = 9000 minor -> 90 points
    expect(acct).toMatchObject({ balance: 90, lifetime_points: 90 });
    const inv = await sqlOne<{ id: string }>(`SELECT invoice_id AS id FROM orders WHERE contact_id = $1`, [contactId]);
    const dup = await earnPoints(org.dataId, contactId, { amountMinor: 9000, refKind: "invoice", refId: inv!.id });
    expect(dup?.duplicate).toBe(true);
    expect((await getAccount(org.dataId, contactId))?.balance).toBe(90);

    const { grantPoints } = await import("@/lib/engagement/loyalty");
    await grantPoints(org.dataId, contactId, 500, "adjust", { refKind: "test", refId: "seed" }, "seed");
    expect((await getAccount(org.dataId, contactId))?.balance).toBe(590);

    const { issueShareToken } = await import("@/lib/share-tokens");
    const portal = await issueShareToken(org.dataId, "portal", contactId, 7);
    const tooMany = await checkout(await newCart(), { discounts: { points: 5000, portal_token: portal.token } }, 400);
    expect(tooMany.body.error).toBe("discount_invalid");
    const spent = await checkout(await newCart(), { discounts: { points: 500, portal_token: portal.token } });
    // 10000 - 500 = 9500 + 10% = 10450
    expect(spent.body.order.total_minor).toBe(10450);
    expect((await getAccount(org.dataId, contactId))?.balance).toBe(90);
    // points without a portal token are refused
    await checkout(await newCart(), { discounts: { points: 100 } }, 400);
  });

  it("gift card: issue once, partial redeem at checkout, balance limiter, refund", async () => {
    const gc = await import("@/app/api/engagement/gift-cards/route");
    const issued = await api<{ gift_card: { id: string; code_last4: string }; code: string }>(gc.POST, "/api/engagement/gift-cards", { json: { amount_minor: 3000, currency: "USD" }, expect: 201 });
    expect(issued.body.code).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
    const stored = await sqlOne<{ code_hash: string }>(`SELECT code_hash FROM gift_cards WHERE id = $1`, [issued.body.gift_card.id]);
    expect(stored!.code_hash).not.toContain(issued.body.code.replace(/-/g, ""));
    const list = await api<{ gift_cards: Array<Record<string, unknown>> }>(gc.GET, "/api/engagement/gift-cards", { expect: 200 });
    expect(JSON.stringify(list.body)).not.toContain(issued.body.code);

    const bal = await import("@/app/api/shop/[org]/gift-card/balance/route");
    const ok = await api<{ balance_minor: number }>(bal.POST, `/api/shop/${slug}/gift-card/balance`, { json: { code: issued.body.code }, params: { org: slug }, expect: 200 });
    expect(ok.body.balance_minor).toBe(3000);
    await api(bal.POST, `/api/shop/${slug}/gift-card/balance`, { json: { code: "ZZZZ-ZZZZ-ZZZZ-ZZZZ" }, params: { org: slug }, expect: 404 });

    const res = await checkout(await newCart(), { discounts: { gift_card: issued.body.code } });
    void res;
    const o = await lastOrder();
    const pays = await sql<{ provider: string; amount_minor: string }>(`SELECT provider, amount_minor FROM invoice_payments WHERE invoice_id = $1`, [o!.invoice_id]);
    expect(pays.filter((p) => p.provider === "gift_card")).toEqual([expect.objectContaining({ amount_minor: "3000" })]);
    const card = await sqlOne<{ balance_minor: string; status: string }>(`SELECT balance_minor, status FROM gift_cards WHERE id = $1`, [issued.body.gift_card.id]);
    expect(Number(card!.balance_minor)).toBe(0);
    expect(card!.status).toBe("redeemed");

    const { refundGiftCardPayment } = await import("@/lib/engagement/giftcards");
    const led = await sqlOne<{ id: string }>(`SELECT id FROM gift_card_ledger WHERE gift_card_id = $1 AND kind = 'redeem'`, [issued.body.gift_card.id]);
    await refundGiftCardPayment(org.dataId, led!.id, 1000, o!.invoice_id);
    const after = await sqlOne<{ balance_minor: string; status: string }>(`SELECT balance_minor, status FROM gift_cards WHERE id = $1`, [issued.body.gift_card.id]);
    expect(Number(after!.balance_minor)).toBe(1000);
    expect(after!.status).toBe("active");
  });

  it("survey: delayed request, dedupe, public response, detractor ticket, testimonial", async () => {
    const { createSurvey, scheduleSurveyRequest, dispatchDueRequests, surveyUrl, loadPublicSurvey, submitSurveyResponse, verifySurveyToken } = await import("@/lib/engagement/surveys");
    const survey = await createSurvey(org.dataId, { name: "NPS", kind: "nps", trigger_event: "order.fulfilled", delay_hours: 24, channel: "email", public_review_prompt: true, review_url: "https://g.page/r/abc" });
    const entity = { kind: "order", id: "ord-test-1", contactId };
    const a = await scheduleSurveyRequest(org.dataId, survey, entity);
    const b = await scheduleSurveyRequest(org.dataId, survey, entity);
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false });

    expect((await dispatchDueRequests(50)).sent).toBe(0); // delay not elapsed
    const later = new Date(Date.now() + 25 * 3_600_000);
    const out = await dispatchDueRequests(50, later);
    expect(out.sent).toBeGreaterThanOrEqual(1);
    const mail = await sqlOne<{ body: string }>(`SELECT body FROM notification_outbox WHERE user_id = $1 AND recipient = $2 AND subject LIKE 'How did we do%'`, [org.dataId, email]);
    expect(mail?.body).toContain("/s/");

    const token = surveyUrl(a.id).split("/s/")[1];
    expect(verifySurveyToken(token)).toBe(a.id);
    expect((await loadPublicSurvey(token))?.questions.length).toBeGreaterThan(0);
    expect(await loadPublicSurvey(token.slice(0, -3) + "abc")).toBeNull();

    const res = await submitSurveyResponse(token, { answers: { score: 3, comment: "Late delivery" }, public_ok: true });
    expect(res.review_url).toBeNull(); // score < 9
    await expect(submitSurveyResponse(token, { answers: { score: 10 } })).rejects.toMatchObject({ code: "already_completed" });

    const ticket = await sqlOne<{ source: string; priority: string }>(`SELECT source, priority FROM tickets WHERE user_id = $1 AND source = 'survey'`, [org.dataId]);
    expect(ticket).toMatchObject({ source: "survey", priority: "high" });
    expect((await eventsFor(org.dataId, "survey.detractor")).length).toBe(1);

    const resp = await sqlOne<{ id: string }>(`SELECT id FROM survey_responses WHERE user_id = $1`, [org.dataId]);
    const r = await import("@/app/api/engagement/responses/route");
    const pub = await api<{ testimonial: { published: boolean; author_name: string } }>(r.PATCH, "/api/engagement/responses", { method: "PATCH", json: { id: resp!.id, action: "publish" }, expect: 200 });
    expect(pub.body.testimonial).toMatchObject({ published: true, author_name: "Buyer O." });
    const pt = await import("@/app/api/public/testimonials/[org]/route");
    const list = await api<{ items: Array<{ quote: string }> }>(pt.GET, `/api/public/testimonials/${org.slug}`, { params: { org: org.slug }, expect: 200 });
    expect(list.body.items[0].quote).toBe("Late delivery");
  });

  it("opt-out is respected for survey email", async () => {
    const { createSurvey, scheduleSurveyRequest, dispatchDueRequests } = await import("@/lib/engagement/surveys");
    await sql(`INSERT INTO contact_optouts (id, user_id, contact_id, email, channel) VALUES ($1,$2,$3,$4,'email')`, [`oo-${Date.now()}`, org.dataId, contactId, email]);
    const s = await createSurvey(org.dataId, { name: "CSAT", kind: "csat", delay_hours: 0, channel: "email" });
    const r = await scheduleSurveyRequest(org.dataId, s, { kind: "order", id: "ord-test-2", contactId });
    await dispatchDueRequests(50, new Date(Date.now() + 1000));
    const row = await sqlOne<{ status: string }>(`SELECT status FROM survey_requests WHERE id = $1`, [r.id]);
    expect(row!.status).toBe("skipped");
  });

  it("referral: self-referral blocked, friend qualifies once", async () => {
    const { getOrCreateReferralCode, captureReferral, qualifyReferral } = await import("@/lib/engagement/referrals");
    const code = await getOrCreateReferralCode(org.dataId, contactId);
    expect(await getOrCreateReferralCode(org.dataId, contactId)).toBe(code);
    const selfId = `ct-self-${Date.now()}`;
    await sql(`INSERT INTO crm_contacts (id, user_id, domain, full_name, email, tags, lifecycle) VALUES ($1,$2,'general','Self',$3,'[]','customer')`, [selfId, org.dataId, "buyer+alt@example.test"]);
    expect(await captureReferral(org.dataId, { code, refereeContactId: selfId })).toMatchObject({ ok: false, reason: "self_referral" });
    const friend = `ct-friend-${Date.now()}`;
    await sql(`INSERT INTO crm_contacts (id, user_id, domain, full_name, email, tags, lifecycle) VALUES ($1,$2,'general','Friend',$3,'[]','customer')`, [friend, org.dataId, "friend@example.test"]);
    expect((await captureReferral(org.dataId, { code, refereeContactId: friend })).ok).toBe(true);
    expect(await captureReferral(org.dataId, { code, refereeContactId: friend })).toMatchObject({ ok: false, reason: "already_referred" });
    const before = (await sqlOne<{ balance: string }>(`SELECT balance FROM loyalty_accounts WHERE contact_id = $1`, [contactId]))!.balance;
    expect(await qualifyReferral(org.dataId, friend, 5000)).toMatchObject({ rewarded: true, points: 500 });
    expect(await qualifyReferral(org.dataId, friend, 5000)).toMatchObject({ rewarded: false });
    const after = (await sqlOne<{ balance: string }>(`SELECT balance FROM loyalty_accounts WHERE contact_id = $1`, [contactId]))!.balance;
    expect(Number(after) - Number(before)).toBe(500);
  });

  it("portal rewards are isolated per org/contact and v1 requires keys", async () => {
    const { issueShareToken } = await import("@/lib/share-tokens");
    const portal = await issueShareToken(org.dataId, "portal", contactId, 7);
    const route = await import("@/app/api/p/portal/[token]/loyalty/route");
    const mine = await api<{ loyalty: { balance: number } }>(route.GET, `/api/p/portal/${portal.token}/loyalty`, { params: { token: portal.token }, expect: 200 });
    expect(mine.body.loyalty.balance).toBeGreaterThan(0);
    await api(route.GET, `/api/p/portal/bogus-token-value/loyalty`, { params: { token: "bogus-token-value" }, expect: 404 });
    // Another org's data never leaks: its contact has no account / program.
    const { getAccount } = await import("@/lib/engagement/loyalty");
    expect(await getAccount(other.dataId, contactId)).toBeNull();
    const v1 = await import("@/app/api/v1/vouchers/route");
    await api(v1.GET, "/api/v1/vouchers", { expect: 401 });
  });
});
