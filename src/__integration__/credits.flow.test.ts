/**
 * AI credits end-to-end: welcome grant → usage charge (idempotent) →
 * enforcement 402 through a real route with a mocked LLM provider →
 * checkout → public /p/credits token → simulated payment → ledger.
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { api, cleanupDataIds, createTestOrg, describeDb, setScope, sql, sqlOne, type TestOrg } from "./setup";

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));

// Mocked LLM provider: every completion "costs" the configured token counts.
const llm = vi.hoisted(() => ({ calls: 0, promptTokens: 1000, completionTokens: 1000, model: "gemini-1.5-pro" }));
vi.mock("@/lib/llm/router", async () => {
  const actual = await vi.importActual<typeof import("@/lib/llm/router")>("@/lib/llm/router");
  return {
    ...actual,
    completeWithTools: async () => {
      llm.calls++;
      return {
        content: JSON.stringify({ summary: "Mocked narrative.", actions: ["Do the thing"] }),
        toolCalls: [],
        provider: "mock",
        model: llm.model,
        promptTokens: llm.promptTokens,
        completionTokens: llm.completionTokens,
        finishReason: "stop",
      };
    },
  };
});

interface Ledger { id: string; kind: string; credits: number; balance_after: number; ref_kind: string | null; ref_id: string | null }
interface CreditsView { balance: number; ledger: Ledger[]; purchases: Array<{ id: string; status: string }>; packs: Array<{ id: string }>; creditsEnforced: boolean; markup: number; provider: string }

describeDb("credits flow", () => {
  let org: TestOrg;
  let purchaseToken: string;
  let purchaseId: string;

  beforeAll(async () => {
    org = await createTestOrg("credits");
    setScope(org);
  });
  afterAll(async () => {
    await cleanupDataIds([org.dataId]);
  });

  it("first touch grants welcome credits exactly once", async () => {
    const { ensureAccount, getBalance } = await import("@/lib/credits/ledger");
    const { FREE_GRANT_CREDITS } = await import("@/lib/credits/packs");
    expect(await ensureAccount(org.dataId)).toBe(FREE_GRANT_CREDITS);
    expect(await ensureAccount(org.dataId)).toBe(FREE_GRANT_CREDITS);
    expect(await getBalance(org.dataId)).toBe(FREE_GRANT_CREDITS);
    const credits = await import("@/app/api/ai/credits/route");
    const v = await api<CreditsView>(credits.GET, "/api/ai/credits", { expect: 200 });
    expect(v.body.balance).toBe(FREE_GRANT_CREDITS);
    expect(v.body.ledger).toHaveLength(1);
    expect(v.body.ledger[0]).toMatchObject({ kind: "grant", credits: FREE_GRANT_CREDITS, balance_after: FREE_GRANT_CREDITS, ref_kind: "signup" });
    expect(v.body.creditsEnforced).toBe(false);
    expect(v.body.provider).toBe("simulated");
    expect(v.body.packs.map((p) => p.id)).toEqual(["starter", "growth", "scale"]);
    expect(await sql(`SELECT user_id FROM ai_credit_accounts WHERE user_id = $1`, [org.dataId])).toHaveLength(1);
  });

  it("recordUsage writes ai_usage and debits credits (cost × markup, ceil, idempotent per usage row)", async () => {
    const { recordUsageDetailed } = await import("@/lib/llm/metering");
    const { estimateCostMicros } = await import("@/lib/llm/pricing");
    const { costMicrosToCredits, creditMarkup } = await import("@/lib/credits/pricing");
    const { chargeForUsage, getBalance } = await import("@/lib/credits/ledger");
    const before = await getBalance(org.dataId);
    const u = await recordUsageDetailed(org.dataId, { feature: "chat", provider: "groq", model: "llama-3.3-70b-versatile", promptTokens: 100_000, completionTokens: 50_000 });
    const expectedCost = estimateCostMicros("llama-3.3-70b-versatile", 100_000, 50_000);
    expect(u.costMicros).toBe(expectedCost);
    expect(expectedCost).toBeGreaterThan(0);
    const expectedCredits = costMicrosToCredits(expectedCost, creditMarkup());
    expect(u.charge).toMatchObject({ credits: expectedCredits, balanceAfter: before - expectedCredits, duplicate: false });
    const usage = await sqlOne<{ cost_micros: number; feature: string; model: string }>(`SELECT cost_micros, feature, model FROM ai_usage WHERE id = $1 AND user_id = $2`, [u.id, org.dataId]);
    expect(Number(usage?.cost_micros)).toBe(expectedCost);
    const entry = await sqlOne<{ credits: number; ref_id: string }>(`SELECT credits, ref_id FROM ai_credit_ledger WHERE user_id = $1 AND kind = 'usage'`, [org.dataId]);
    expect(Number(entry?.credits)).toBe(-expectedCredits);
    expect(entry?.ref_id).toBe(u.id);
    // Replaying the same usage id never double-charges.
    const again = await chargeForUsage(org.dataId, { usageId: u.id, costMicros: expectedCost });
    expect(again.duplicate).toBe(true);
    expect(await getBalance(org.dataId)).toBe(before - expectedCredits);
    expect(await sql(`SELECT id FROM ai_credit_ledger WHERE user_id = $1 AND kind = 'usage'`, [org.dataId])).toHaveLength(1);
  });

  it("enforcement: the metered route returns 402 once credits run out, and skips the model when already exhausted", async () => {
    const credits = await import("@/app/api/ai/credits/route");
    const pricing = await import("@/app/api/optimize/pricing/route");
    const { postLedger, getBalance } = await import("@/lib/credits/ledger");
    const body = { items: [{ description: "Design", qty: 10, unit_minor: 10000 }], narrate: true };

    // Not enforced: a huge call drives the balance negative but still succeeds.
    llm.promptTokens = 2_000_000;
    llm.completionTokens = 2_000_000;
    llm.calls = 0;
    const free = await api<{ suggestion: unknown; narrative: { summary: string } | null }>(pricing.POST, "/api/optimize/pricing", { json: body, expect: 200 });
    expect(free.body.narrative?.summary).toBe("Mocked narrative.");
    expect(llm.calls).toBe(1);
    const negative = await getBalance(org.dataId);
    expect(negative).toBeLessThan(0);

    // Top the balance back up to a sliver, enforce, and call again: the call runs, the debit crosses zero → 402.
    await postLedger(org.dataId, { kind: "adjustment", credits: -negative + 5, refKind: "test", refId: `topup-${org.dataId}`, note: "test top-up" });
    expect(await getBalance(org.dataId)).toBe(5);
    const on = await api<{ creditsEnforced: boolean }>(credits.PATCH, "/api/ai/credits", { method: "PATCH", json: { creditsEnforced: true }, expect: 200 });
    expect(on.body.creditsEnforced).toBe(true);
    llm.calls = 0;
    const blocked = await api<{ suggestion: unknown; narrative: null; error: string; balance?: number }>(pricing.POST, "/api/optimize/pricing", { json: body, expect: 402 });
    expect(blocked.body.error).toBe("credits_exhausted");
    expect(blocked.body.suggestion).toBeTruthy(); // the deterministic part is still returned
    expect(llm.calls).toBe(1);
    expect(await getBalance(org.dataId)).toBeLessThan(0);
    // Already exhausted: refused before any model call.
    llm.calls = 0;
    const again = await api<{ error: string }>(pricing.POST, "/api/optimize/pricing", { json: body, expect: 402 });
    expect(again.body.error).toBe("credits_exhausted");
    expect(llm.calls).toBe(0);
    // Without narration the route never touches the model or the ledger.
    await api(pricing.POST, "/api/optimize/pricing", { json: { ...body, narrate: false }, expect: 200 });
    expect(llm.calls).toBe(0);
    // The generic LLM error mapper also yields 402 for this error.
    const { llmErrorResponse } = await import("@/lib/llm-response");
    const { InsufficientCreditsError } = await import("@/lib/credits/errors");
    const mapped = llmErrorResponse(new InsufficientCreditsError(-3));
    expect(mapped?.status).toBe(402);
    expect(await mapped?.json()).toMatchObject({ code: "credits_exhausted", balance: -3 });
  });

  it("checkout → public token → simulated payment credits the account once", async () => {
    const checkout = await import("@/app/api/ai/credits/checkout/route");
    await api(checkout.POST, "/api/ai/credits/checkout", { json: { packId: "platinum" }, expect: 404 });
    await api(checkout.POST, "/api/ai/credits/checkout", { json: {}, expect: 400 });
    const r = await api<{ url: string; purchaseId: string; provider: string; pack: { id: string; credits: number; price_minor: number } }>(checkout.POST, "/api/ai/credits/checkout", { json: { packId: "starter" }, expect: 201 });
    purchaseId = r.body.purchaseId;
    expect(r.body.provider).toBe("simulated");
    expect(r.res.headers.get("location")).toBe(r.body.url);
    purchaseToken = r.body.url.split("/p/credits/")[1]?.split("?")[0] ?? "";
    expect(purchaseToken.length).toBeGreaterThan(20);
    const pending = await sqlOne<{ status: string; credits: number; amount_minor: number; token_hash: string }>(`SELECT status, credits, amount_minor, token_hash FROM ai_credit_purchases WHERE id = $1 AND user_id = $2`, [purchaseId, org.dataId]);
    expect(pending).toMatchObject({ status: "pending" });
    expect(Number(pending?.credits)).toBe(10_000);
    expect(Number(pending?.amount_minor)).toBe(1_000);
    expect(pending?.token_hash).not.toBe(purchaseToken);

    const pub = await import("@/app/api/p/credits/[token]/route");
    const g = await api<{ purchase: { id: string; status: string; credits: number }; provider: string }>(pub.GET, `/api/p/credits/${purchaseToken}`, { params: { token: purchaseToken }, expect: 200 });
    expect(g.body.purchase).toMatchObject({ id: purchaseId, status: "pending", credits: 10_000 });
    await api(pub.GET, `/api/p/credits/nope`, { params: { token: "nope" }, expect: 404 });

    const { getBalance } = await import("@/lib/credits/ledger");
    const before = await getBalance(org.dataId);
    const pay = await api<{ ok: boolean; status: string; credited: boolean }>(pub.POST, `/api/p/credits/${purchaseToken}`, { json: { outcome: "success" }, params: { token: purchaseToken }, expect: 200 });
    expect(pay.body).toMatchObject({ ok: true, status: "paid", credited: true });
    expect(await getBalance(org.dataId)).toBe(before + 10_000);
    const paid = await sqlOne<{ status: string; paid_at: string | null }>(`SELECT status, paid_at FROM ai_credit_purchases WHERE id = $1`, [purchaseId]);
    expect(paid?.status).toBe("paid");
    expect(paid?.paid_at).toBeTruthy();
    const entry = await sqlOne<Ledger>(`SELECT id, kind, credits, balance_after, ref_kind, ref_id FROM ai_credit_ledger WHERE user_id = $1 AND kind = 'purchase'`, [org.dataId]);
    expect(entry).toMatchObject({ ref_kind: "purchase", ref_id: purchaseId });
    expect(Number(entry?.credits)).toBe(10_000);

    // Replay: still paid, not credited twice.
    const replay = await api<{ status: string; credited: boolean }>(pub.POST, `/api/p/credits/${purchaseToken}`, { json: { outcome: "success" }, params: { token: purchaseToken }, expect: 200 });
    expect(replay.body).toMatchObject({ status: "paid", credited: false });
    expect(await getBalance(org.dataId)).toBe(before + 10_000);
    expect(await sql(`SELECT id FROM ai_credit_ledger WHERE user_id = $1 AND kind = 'purchase'`, [org.dataId])).toHaveLength(1);

    // A failed checkout marks the purchase failed and credits nothing.
    const r2 = await api<{ url: string; purchaseId: string }>(checkout.POST, "/api/ai/credits/checkout", { json: { packId: "growth" }, expect: 201 });
    const token2 = r2.body.url.split("/p/credits/")[1]?.split("?")[0] ?? "";
    const fail = await api<{ status: string; credited: boolean }>(pub.POST, `/api/p/credits/${token2}`, { json: { outcome: "failure" }, params: { token: token2 }, expect: 200 });
    expect(fail.body).toMatchObject({ status: "failed", credited: false });
    expect(await getBalance(org.dataId)).toBe(before + 10_000);
    // Expired pending links are refused with 410.
    const r3 = await api<{ url: string; purchaseId: string }>(checkout.POST, "/api/ai/credits/checkout", { json: { packId: "starter" }, expect: 201 });
    await sql(`UPDATE ai_credit_purchases SET created_at = NOW() - INTERVAL '8 days' WHERE id = $1`, [r3.body.purchaseId]);
    const token3 = r3.body.url.split("/p/credits/")[1]?.split("?")[0] ?? "";
    await api(pub.GET, `/api/p/credits/${token3}`, { params: { token: token3 }, expect: 410 });
    await api(pub.POST, `/api/p/credits/${token3}`, { json: { outcome: "success" }, params: { token: token3 }, expect: 410 });

    const credits = await import("@/app/api/ai/credits/route");
    const v = await api<CreditsView>(credits.GET, "/api/ai/credits", { expect: 200 });
    expect(v.body.balance).toBe(before + 10_000);
    expect(v.body.purchases.map((p) => p.status).sort()).toEqual(["failed", "paid", "pending"]);
    expect(v.body.ledger.map((l) => l.kind)).toEqual(expect.arrayContaining(["grant", "usage", "adjustment", "purchase"]));
    // The pack did not cover the overdraft from the enforcement test → still 402 while enforced…
    llm.promptTokens = 10;
    llm.completionTokens = 10;
    const pricing = await import("@/app/api/optimize/pricing/route");
    const stillNegative = await getBalance(org.dataId);
    expect(stillNegative).toBeLessThan(0);
    await api(pricing.POST, "/api/optimize/pricing", { json: { items: [{ description: "x", qty: 1, unit_minor: 100 }], narrate: true }, expect: 402 });
    // …until the balance is positive again, when the metered route works while enforced.
    const { postLedger } = await import("@/lib/credits/ledger");
    await postLedger(org.dataId, { kind: "adjustment", credits: -stillNegative + 1_000, refKind: "test", refId: `restore-${org.dataId}`, note: "test restore" });
    llm.calls = 0;
    await api(pricing.POST, "/api/optimize/pricing", { json: { items: [{ description: "x", qty: 1, unit_minor: 100 }], narrate: true }, expect: 200 });
    expect(llm.calls).toBe(1);
    expect(await getBalance(org.dataId)).toBeLessThan(1_000);
    expect(await getBalance(org.dataId)).toBeGreaterThan(0);
  });

  it("viewer cannot toggle enforcement or start checkout", async () => {
    setScope(org, { role: "viewer", userId: "itest-viewer" });
    const credits = await import("@/app/api/ai/credits/route");
    await api(credits.PATCH, "/api/ai/credits", { method: "PATCH", json: { creditsEnforced: false }, expect: 403 });
    await api(credits.GET, "/api/ai/credits", { expect: 403 });
    const checkout = await import("@/app/api/ai/credits/checkout/route");
    await api(checkout.POST, "/api/ai/credits/checkout", { json: { packId: "starter" }, expect: 403 });
    setScope(org);
  });
});
