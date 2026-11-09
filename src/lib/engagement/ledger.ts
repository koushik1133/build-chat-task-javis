import { randomUUID } from "crypto";
import { query, queryOne, withRetry } from "@/lib/dsql";

/**
 * Optimistic balance + unique-ref ledger shared by loyalty points and gift
 * cards (same pattern as src/lib/credits/ledger.ts): read the balance, apply a
 * conditional UPDATE on the expected value, then append the ledger row. A
 * (user, kind, ref_kind, ref_id) triple posts at most once (checked up front
 * and enforced by a unique index), so retries and replays are harmless.
 */

export interface LedgerCfg {
  account: "loyalty_accounts" | "gift_cards";
  balanceCol: "balance" | "balance_minor";
  ledger: "loyalty_ledger" | "gift_card_ledger";
  accountFk: "account_id" | "gift_card_id";
  amountCol: "points" | "amount_minor";
  hasNote: boolean;
}
export const LOYALTY_CFG: LedgerCfg = { account: "loyalty_accounts", balanceCol: "balance", ledger: "loyalty_ledger", accountFk: "account_id", amountCol: "points", hasNote: true };
export const GIFT_CFG: LedgerCfg = { account: "gift_cards", balanceCol: "balance_minor", ledger: "gift_card_ledger", accountFk: "gift_card_id", amountCol: "amount_minor", hasNote: false };

export class InsufficientBalanceError extends Error {
  constructor(public readonly available: number) {
    super("Insufficient balance");
    this.name = "InsufficientBalanceError";
  }
}

export interface PostResult {
  id: string;
  balanceAfter: number;
  duplicate: boolean;
}

export interface PostEntry {
  kind: string;
  refKind?: string | null;
  refId?: string | null;
  note?: string | null;
}

function pgCode(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  const direct = "code" in err ? String((err as { code: unknown }).code) : "";
  const cause = "cause" in err ? (err as { cause?: { code?: unknown } }).cause : undefined;
  return direct || (cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "");
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function findExisting(cfg: LedgerCfg, dataId: string, entry: PostEntry): Promise<PostResult | null> {
  if (!entry.refKind || !entry.refId) return null;
  const row = await queryOne<{ id: string; balance_after: string | number }>(`SELECT id, balance_after FROM ${cfg.ledger} WHERE user_id = $1 AND kind = $2 AND ref_kind = $3 AND ref_id = $4`, [dataId, entry.kind, entry.refKind, entry.refId]);
  return row ? { id: row.id, balanceAfter: Number(row.balance_after), duplicate: true } : null;
}

/** Apply a signed delta. Throws InsufficientBalanceError when the result would be negative. */
export async function postDelta(cfg: LedgerCfg, dataId: string, accountId: string, delta: number, entry: PostEntry): Promise<PostResult> {
  const amount = Math.trunc(delta);
  if (!Number.isFinite(amount)) throw new Error("amount must be a finite integer");
  const dup = await findExisting(cfg, dataId, entry);
  if (dup) return dup;

  for (let attempt = 0; attempt < 6; attempt++) {
    const cur = await queryOne<{ b: string | number }>(`SELECT ${cfg.balanceCol} AS b FROM ${cfg.account} WHERE id = $1 AND user_id = $2`, [accountId, dataId]);
    if (!cur) throw new Error("account not found");
    const expected = Number(cur.b);
    const after = expected + amount;
    if (after < 0) throw new InsufficientBalanceError(expected);
    const updated = await withRetry(() =>
      queryOne<{ id: string }>(`UPDATE ${cfg.account} SET ${cfg.balanceCol} = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2 AND ${cfg.balanceCol} = $4 RETURNING id`, [accountId, dataId, after, expected])
    );
    if (!updated) {
      await sleep(15 * 2 ** attempt + Math.floor(Math.random() * 15));
      continue;
    }
    const id = randomUUID();
    try {
      if (cfg.hasNote) {
        await query(`INSERT INTO ${cfg.ledger} (id, user_id, ${cfg.accountFk}, kind, ${cfg.amountCol}, balance_after, ref_kind, ref_id, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, dataId, accountId, entry.kind, amount, after, entry.refKind ?? null, entry.refId ?? null, entry.note?.slice(0, 500) ?? null]);
      } else {
        await query(`INSERT INTO ${cfg.ledger} (id, user_id, ${cfg.accountFk}, kind, ${cfg.amountCol}, balance_after, ref_kind, ref_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, dataId, accountId, entry.kind, amount, after, entry.refKind ?? null, entry.refId ?? null]);
      }
    } catch (err) {
      await query(`UPDATE ${cfg.account} SET ${cfg.balanceCol} = ${cfg.balanceCol} - $3, updated_at = NOW() WHERE id = $1 AND user_id = $2`, [accountId, dataId, amount]).catch((e) => console.error("[engagement] failed to compensate balance:", e));
      if (pgCode(err) === "23505") {
        const again = await findExisting(cfg, dataId, entry);
        if (again) return again;
      }
      throw err;
    }
    return { id, balanceAfter: after, duplicate: false };
  }
  throw new Error("ledger contention: giving up after retries");
}
