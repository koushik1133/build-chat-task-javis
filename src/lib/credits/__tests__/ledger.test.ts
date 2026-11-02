import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const queryOne = vi.fn();
vi.mock("@/lib/dsql", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
  withRetry: async <T,>(fn: () => Promise<T>) => fn(),
}));

import { chargeForUsage, chargeOutcome, getBalance, postLedger } from "@/lib/credits/ledger";
import { costMicrosToCredits, creditMarkup, creditsToUnits, DEFAULT_MARKUP } from "@/lib/credits/pricing";
import { FREE_GRANT_CREDITS } from "@/lib/credits/packs";

/**
 * In-memory stand-in for ai_credit_accounts + ai_credit_ledger that honours
 * the conditional `WHERE balance = $expected` update, so the race-safety and
 * idempotency logic is exercised for real.
 */
function mockDb(opts: { startBalance?: number | null; conflictOnce?: boolean } = {}) {
  let balance: number | null = opts.startBalance === undefined ? 0 : opts.startBalance;
  let conflict = Boolean(opts.conflictOnce);
  const ledger: Array<Record<string, unknown>> = [];

  queryOne.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes("SELECT balance FROM ai_credit_accounts")) return balance === null ? null : { balance };
    if (sql.startsWith("UPDATE ai_credit_accounts SET balance = $2")) {
      const [, after, expected] = params as [string, number, number];
      if (conflict) {
        // Simulate another writer that moved the balance between read and write.
        conflict = false;
        balance = (balance ?? 0) + 7;
        return null;
      }
      if (balance !== expected) return null;
      balance = after;
      return { balance };
    }
    if (sql.includes("FROM ai_credit_ledger WHERE user_id = $1 AND kind = $2")) {
      const [, kind, refKind, refId] = params as string[];
      const row = ledger.find((l) => l.kind === kind && l.ref_kind === refKind && l.ref_id === refId);
      return row ? { id: row.id, balance_after: row.balance_after } : null;
    }
    return null;
  });
  query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.startsWith("INSERT INTO ai_credit_accounts")) {
      if (balance !== null) throw Object.assign(new Error("dup"), { code: "23505" });
      balance = 0;
      return [];
    }
    if (sql.startsWith("INSERT INTO ai_credit_ledger")) {
      const [id, , kind, credits, balance_after, ref_kind, ref_id] = params as unknown[];
      ledger.push({ id, kind, credits, balance_after, ref_kind, ref_id });
      return [];
    }
    if (sql.startsWith("UPDATE ai_credit_accounts SET balance = balance - $2")) {
      balance = (balance ?? 0) - Number(params[1]);
      return [];
    }
    return [];
  });
  return { get balance() { return balance; }, ledger };
}

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  delete process.env.AI_CREDIT_MARKUP;
});

describe("credit pricing", () => {
  it("converts cost micros to credits with the markup, rounding up to at least one credit", () => {
    expect(costMicrosToCredits(0, 1.5)).toBe(0);
    expect(costMicrosToCredits(1, 1.5)).toBe(1); // tiny but non-zero → 1 credit
    expect(costMicrosToCredits(1_000_000, 1.5)).toBe(1500); // $1 of cost → 1500 credits at 1.5×
    expect(costMicrosToCredits(2_000, 1)).toBe(2); // 2000 micros = 2 credits exactly
    expect(costMicrosToCredits(2_001, 1)).toBe(3); // ceil
    expect(creditsToUnits(1500)).toBe(1.5);
  });

  it("reads the markup from the environment and falls back to the default", () => {
    expect(creditMarkup({})).toBe(DEFAULT_MARKUP);
    expect(creditMarkup({ AI_CREDIT_MARKUP: "2" })).toBe(2);
    expect(creditMarkup({ AI_CREDIT_MARKUP: "nope" })).toBe(DEFAULT_MARKUP);
    expect(creditMarkup({ AI_CREDIT_MARKUP: "-1" })).toBe(DEFAULT_MARKUP);
  });
});

describe("ledger", () => {
  it("creates the account with the free grant on first use", async () => {
    const db = mockDb({ startBalance: null });
    expect(await getBalance("u1")).toBe(FREE_GRANT_CREDITS);
    expect(db.ledger).toHaveLength(1);
    expect(db.ledger[0]).toMatchObject({ kind: "grant", credits: FREE_GRANT_CREDITS, balance_after: FREE_GRANT_CREDITS, ref_kind: "signup", ref_id: "u1" });
    // Second call: no second grant.
    expect(await getBalance("u1")).toBe(FREE_GRANT_CREDITS);
    expect(db.ledger).toHaveLength(1);
  });

  it("keeps balance_after consistent across signed entries", async () => {
    const db = mockDb({ startBalance: 100 });
    const a = await postLedger("u1", { kind: "purchase", credits: 50, refKind: "purchase", refId: "p1" });
    const b = await postLedger("u1", { kind: "usage", credits: -30, refKind: "usage", refId: "x1" });
    expect(a.balanceAfter).toBe(150);
    expect(b.balanceAfter).toBe(120);
    expect(db.balance).toBe(120);
    expect(db.ledger.map((l) => l.balance_after)).toEqual([150, 120]);
  });

  it("retries from a fresh read when the conditional update loses a race", async () => {
    const db = mockDb({ startBalance: 100, conflictOnce: true });
    const res = await postLedger("u1", { kind: "usage", credits: -10 });
    // The other writer added 7 before we got in, so our entry lands on 107 - 10.
    expect(res.balanceAfter).toBe(97);
    expect(db.balance).toBe(97);
    expect(db.ledger).toHaveLength(1);
  });

  it("charges usage with the markup and is idempotent per usage id", async () => {
    process.env.AI_CREDIT_MARKUP = "2";
    const db = mockDb({ startBalance: 1000 });
    const first = await chargeForUsage("u1", { usageId: "use-1", costMicros: 10_000 }); // 10 credits × 2
    expect(first).toMatchObject({ credits: 20, balanceAfter: 980, duplicate: false });
    const again = await chargeForUsage("u1", { usageId: "use-1", costMicros: 10_000 });
    expect(again).toMatchObject({ credits: 20, balanceAfter: 980, duplicate: true });
    expect(db.balance).toBe(980);
    expect(db.ledger).toHaveLength(1);
  });

  it("posts nothing for a zero-cost call", async () => {
    const db = mockDb({ startBalance: 10 });
    const res = await chargeForUsage("u1", { usageId: "use-0", costMicros: 0 });
    expect(res).toMatchObject({ credits: 0, balanceAfter: 10 });
    expect(db.ledger).toHaveLength(0);
  });

  it("charges an outcome exactly once per run", async () => {
    const db = mockDb({ startBalance: 1000 });
    const first = await chargeOutcome("u1", { agentId: "a1", runId: "run-1", outcome: "booking.created", credits: 500 });
    const second = await chargeOutcome("u1", { agentId: "a1", runId: "run-1", outcome: "booking.created", credits: 500 });
    expect(first).toEqual({ charged: true, balanceAfter: 500 });
    expect(second).toEqual({ charged: false, balanceAfter: 500 });
    expect(db.balance).toBe(500);
    expect(db.ledger).toHaveLength(1);
    expect(db.ledger[0]).toMatchObject({ kind: "outcome", credits: -500, ref_kind: "run", ref_id: "run-1" });
  });

  it("recovers the idempotent row when the unique index rejects a concurrent duplicate", async () => {
    const db = mockDb({ startBalance: 100 });
    // First insert "succeeds" elsewhere: seed the ledger directly, then make our insert hit 23505.
    db.ledger.push({ id: "existing", kind: "outcome", credits: -5, balance_after: 95, ref_kind: "run", ref_id: "r9" });
    const existingFinder = queryOne.getMockImplementation()!;
    queryOne.mockImplementation(async (sql: string, params: unknown[]) => {
      // Hide the existing row from the up-front check so the insert path runs.
      if (sql.includes("FROM ai_credit_ledger") && !sql.includes("never")) {
        const calls = queryOne.mock.calls.filter((c) => String(c[0]).includes("FROM ai_credit_ledger")).length;
        if (calls <= 1) return null;
      }
      return existingFinder(sql, params);
    });
    const baseQuery = query.getMockImplementation()!;
    query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.startsWith("INSERT INTO ai_credit_ledger")) throw Object.assign(new Error("dup"), { code: "23505" });
      return baseQuery(sql, params);
    });
    const res = await chargeOutcome("u1", { agentId: "a1", runId: "r9", outcome: "x.y", credits: 5 });
    expect(res).toEqual({ charged: false, balanceAfter: 95 });
    // Balance was compensated back after the failed insert.
    expect(db.balance).toBe(100);
  });
});
