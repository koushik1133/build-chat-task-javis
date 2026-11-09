import { randomUUID } from "crypto";
import { query, queryOne, withRetry } from "@/lib/dsql";
import { FREE_GRANT_CREDITS } from "./packs";
import { keysetClause, keysetOrder, type Cursor } from "@/lib/public-api/pagination";
import { costMicrosToCredits, creditMarkup } from "./pricing";

export { InsufficientCreditsError, isInsufficientCreditsError } from "./errors";

/**
 * AI credit ledger.
 *
 * `ai_credit_accounts.balance` is the current balance; every change goes
 * through `postLedger`, which updates the account with an optimistic
 * `WHERE balance = <expected>` guard and only then appends the ledger row
 * (with `balance_after`). Concurrent writers retry from a fresh read, so the
 * running balance never drifts from the ledger.
 *
 * Idempotency: a (kind, ref_kind, ref_id) triple is posted at most once —
 * checked up front and enforced by a unique index.
 */

export type LedgerKind = "purchase" | "grant" | "usage" | "outcome" | "refund" | "adjustment";

export interface LedgerRow {
  id: string;
  user_id: string;
  kind: LedgerKind;
  credits: string | number;
  balance_after: string | number;
  ref_kind: string | null;
  ref_id: string | null;
  note: string | null;
  created_at: string;
}

export interface LedgerEntry {
  id: string;
  kind: LedgerKind;
  credits: number;
  balance_after: number;
  ref_kind: string | null;
  ref_id: string | null;
  note: string | null;
  created_at: string;
}

export interface PostLedgerInput {
  kind: LedgerKind;
  /** Signed: positive adds credits, negative spends them. */
  credits: number;
  refKind?: string | null;
  refId?: string | null;
  note?: string | null;
}

export interface PostLedgerResult {
  id: string;
  balanceAfter: number;
  /** True when this (kind, ref) was already posted; nothing changed. */
  duplicate: boolean;
}

const MAX_ATTEMPTS = 6;

function pgCode(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  const direct = "code" in err ? String((err as { code: unknown }).code) : "";
  const cause = "cause" in err ? (err as { cause?: { code?: unknown } }).cause : undefined;
  return direct || (cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toEntry(r: LedgerRow): LedgerEntry {
  return {
    id: r.id,
    kind: r.kind,
    credits: Number(r.credits),
    balance_after: Number(r.balance_after),
    ref_kind: r.ref_kind,
    ref_id: r.ref_id,
    note: r.note,
    created_at: r.created_at,
  };
}

async function readBalance(userId: string): Promise<number | null> {
  const row = await queryOne<{ balance: string | number }>(`SELECT balance FROM ai_credit_accounts WHERE user_id = $1`, [userId]);
  return row ? Number(row.balance) || 0 : null;
}

async function findExisting(userId: string, input: PostLedgerInput): Promise<PostLedgerResult | null> {
  if (!input.refKind || !input.refId) return null;
  const row = await queryOne<{ id: string; balance_after: string | number }>(
    `SELECT id, balance_after FROM ai_credit_ledger WHERE user_id = $1 AND kind = $2 AND ref_kind = $3 AND ref_id = $4`,
    [userId, input.kind, input.refKind, input.refId]
  );
  return row ? { id: row.id, balanceAfter: Number(row.balance_after), duplicate: true } : null;
}

/** Apply one entry to an account that is known to exist. */
async function postEntry(userId: string, input: PostLedgerInput): Promise<PostLedgerResult> {
  const credits = Math.trunc(Number(input.credits));
  if (!Number.isFinite(credits)) throw new Error("credits must be a finite integer");

  const existing = await findExisting(userId, input);
  if (existing) return existing;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const expected = await readBalance(userId);
    if (expected === null) throw new Error("credit account missing");
    const after = expected + credits;

    const updated = await withRetry(() =>
      queryOne<{ balance: string | number }>(
        `UPDATE ai_credit_accounts SET balance = $2, updated_at = NOW()
         WHERE user_id = $1 AND balance = $3
         RETURNING balance`,
        [userId, after, expected]
      )
    );
    if (!updated) {
      // Someone else moved the balance between our read and write; re-read.
      await sleep(20 * 2 ** attempt + Math.floor(Math.random() * 20));
      continue;
    }

    const id = randomUUID();
    try {
      await query(
        `INSERT INTO ai_credit_ledger (id, user_id, kind, credits, balance_after, ref_kind, ref_id, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, userId, input.kind, credits, after, input.refKind ?? null, input.refId ?? null, input.note?.slice(0, 500) ?? null]
      );
    } catch (err) {
      // Roll the balance back so the account never carries an entry that has no ledger row.
      await query(`UPDATE ai_credit_accounts SET balance = balance - $2, updated_at = NOW() WHERE user_id = $1`, [userId, credits]).catch(
        (e) => console.error("[credits] failed to compensate balance:", e)
      );
      if (pgCode(err) === "23505") {
        const dup = await findExisting(userId, input);
        if (dup) return dup;
      }
      throw err;
    }
    return { id, balanceAfter: after, duplicate: false };
  }
  throw new Error("credit ledger contention: giving up after retries");
}

/**
 * Make sure the account row exists; first-time users get the free grant
 * (idempotent on ref signup/<userId>). Returns the current balance.
 */
export async function ensureAccount(userId: string): Promise<number> {
  const current = await readBalance(userId);
  if (current !== null) return current;
  try {
    await query(`INSERT INTO ai_credit_accounts (user_id, balance) VALUES ($1, 0)`, [userId]);
  } catch (err) {
    if (pgCode(err) !== "23505") throw err;
  }
  const granted = await postEntry(userId, {
    kind: "grant",
    credits: FREE_GRANT_CREDITS,
    refKind: "signup",
    refId: userId,
    note: "Welcome credits",
  });
  return granted.balanceAfter;
}

export async function getBalance(userId: string): Promise<number> {
  return ensureAccount(userId);
}

export async function postLedger(userId: string, input: PostLedgerInput): Promise<PostLedgerResult> {
  await ensureAccount(userId);
  return postEntry(userId, input);
}

export async function listLedger(userId: string, limit = 50, cursor: Cursor | null = null): Promise<LedgerEntry[]> {
  const params: unknown[] = [userId];
  const keyset = keysetClause(cursor, params);
  params.push(Math.min(Math.max(limit, 1), 201));
  const rows = await query<LedgerRow>(
    `SELECT id, user_id, kind, credits, balance_after, ref_kind, ref_id, note, created_at
       FROM ai_credit_ledger WHERE user_id = $1${keyset} ORDER BY ${keysetOrder()} LIMIT $${params.length}`,
    params
  );
  return rows.map(toEntry);
}

export interface UsageCharge {
  /** ai_usage row id — the idempotency key for this charge. */
  usageId: string;
  costMicros: number;
  runId?: string | null;
  feature?: string | null;
  model?: string | null;
}

export interface ChargeResult {
  credits: number;
  balanceAfter: number;
  duplicate: boolean;
}

/** Convert a metered model call into a usage debit (cost × markup). Zero-cost calls post nothing. */
export async function chargeForUsage(userId: string, usage: UsageCharge): Promise<ChargeResult> {
  const credits = costMicrosToCredits(usage.costMicros, creditMarkup());
  if (credits <= 0) return { credits: 0, balanceAfter: await getBalance(userId), duplicate: false };
  const res = await postLedger(userId, {
    kind: "usage",
    credits: -credits,
    refKind: "usage",
    refId: usage.usageId,
    note: [usage.feature, usage.model].filter(Boolean).join(" · ") || null,
  });
  return { credits, balanceAfter: res.balanceAfter, duplicate: res.duplicate };
}

export interface OutcomeCharge {
  agentId: string;
  runId: string;
  /** Event type that fired, e.g. booking.created. */
  outcome: string;
  credits: number;
}

/** Charge an outcome price once per run (idempotent on run id). */
export async function chargeOutcome(userId: string, input: OutcomeCharge): Promise<{ charged: boolean; balanceAfter: number }> {
  const credits = Math.trunc(Number(input.credits));
  if (!(credits > 0)) return { charged: false, balanceAfter: await getBalance(userId) };
  const res = await postLedger(userId, {
    kind: "outcome",
    credits: -credits,
    refKind: "run",
    refId: input.runId,
    note: `${input.outcome} · agent ${input.agentId}`,
  });
  return { charged: !res.duplicate, balanceAfter: res.balanceAfter };
}
