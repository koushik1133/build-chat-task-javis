import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";
import { LOYALTY_CFG, InsufficientBalanceError, postDelta, type PostResult } from "./ledger";
import { DEFAULT_PROGRAM, ProgramPatchSchema, expirablePoints, maxRedeemablePoints, parseTiers, pointsForAmount, pointsValueMinor, tierFor, type LoyaltyKind, type LoyaltyProgram } from "./pure";
import type { z } from "zod";

/**
 * Loyalty points. Balance changes go through the shared optimistic ledger
 * (conditional UPDATE + unique (user, kind, ref_kind, ref_id)), so an invoice
 * or order that fires its paid hook twice earns once.
 *
 * Expiry simplification: points are not tracked as lots. `expirePoints`
 * treats spending as consuming the oldest points first, so a member's expirable
 * points = earned-before-cutoff minus everything spent/expired so far.
 */

interface ProgramRow {
  user_id: string;
  enabled: boolean;
  earn_points: number;
  per_minor: number;
  redeem_value_minor_per_point: number;
  tiers: string;
  expiry_months: number | null;
  min_redeem_points: number;
  max_redeem_pct_bp: number;
}
const toProgram = (r: ProgramRow): LoyaltyProgram => ({ enabled: Boolean(r.enabled), earn_points: Number(r.earn_points), per_minor: Number(r.per_minor), redeem_value_minor_per_point: Number(r.redeem_value_minor_per_point), tiers: parseTiers(r.tiers), expiry_months: r.expiry_months === null ? null : Number(r.expiry_months), min_redeem_points: Number(r.min_redeem_points), max_redeem_pct_bp: Number(r.max_redeem_pct_bp) });

export async function getProgram(dataId: string): Promise<LoyaltyProgram> {
  const r = await queryOne<ProgramRow>(`SELECT * FROM loyalty_programs WHERE user_id = $1`, [dataId]).catch(() => null);
  return r ? toProgram(r) : { ...DEFAULT_PROGRAM };
}

export async function updateProgram(dataId: string, patch: z.infer<typeof ProgramPatchSchema>): Promise<LoyaltyProgram> {
  const next: LoyaltyProgram = { ...(await getProgram(dataId)), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as LoyaltyProgram;
  next.tiers = [...next.tiers].sort((a, b) => a.min_points - b.min_points);
  await query(
    `INSERT INTO loyalty_programs (user_id, enabled, earn_points, per_minor, redeem_value_minor_per_point, tiers, expiry_months, min_redeem_points, max_redeem_pct_bp, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
     ON CONFLICT (user_id) DO UPDATE SET enabled = $2, earn_points = $3, per_minor = $4, redeem_value_minor_per_point = $5, tiers = $6, expiry_months = $7, min_redeem_points = $8, max_redeem_pct_bp = $9, updated_at = NOW()`,
    [dataId, next.enabled, next.earn_points, next.per_minor, next.redeem_value_minor_per_point, JSON.stringify(next.tiers), next.expiry_months, next.min_redeem_points, next.max_redeem_pct_bp]
  );
  return next;
}

export interface AccountDTO {
  id: string;
  contact_id: string;
  balance: number;
  lifetime_points: number;
  tier: string | null;
  updated_at: string;
}
interface AccountRow { id: string; contact_id: string; balance: string | number; lifetime_points: string | number; tier: string | null; updated_at: string | Date }
const toAccount = (r: AccountRow): AccountDTO => ({ id: r.id, contact_id: r.contact_id, balance: Number(r.balance), lifetime_points: Number(r.lifetime_points), tier: r.tier, updated_at: new Date(r.updated_at).toISOString() });
const ACCOUNT_COLS = "id, contact_id, balance, lifetime_points, tier, updated_at";

export async function getAccount(dataId: string, contactId: string): Promise<AccountDTO | null> {
  const r = await queryOne<AccountRow>(`SELECT ${ACCOUNT_COLS} FROM loyalty_accounts WHERE user_id = $1 AND contact_id = $2`, [dataId, contactId]);
  return r ? toAccount(r) : null;
}

export async function getOrCreateAccount(dataId: string, contactId: string): Promise<AccountDTO> {
  const existing = await getAccount(dataId, contactId);
  if (existing) return existing;
  const contact = await queryOne(`SELECT id FROM crm_contacts WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, [contactId, dataId]);
  if (!contact) throw new Error("Contact not found");
  try {
    await query(`INSERT INTO loyalty_accounts (id, user_id, contact_id, balance, lifetime_points, tier) VALUES ($1,$2,$3,0,0,NULL)`, [randomUUID(), dataId, contactId]);
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
    if (code !== "23505") throw err;
  }
  const row = await getAccount(dataId, contactId);
  if (!row) throw new Error("Loyalty account could not be created");
  return row;
}

/** Recompute lifetime points and tier after a positive posting; emits loyalty.tier_changed when the tier moves. */
async function bumpLifetime(dataId: string, account: AccountDTO, program: LoyaltyProgram, points: number): Promise<void> {
  if (points <= 0) return;
  const row = await queryOne<{ lifetime_points: string | number; tier: string | null }>(`UPDATE loyalty_accounts SET lifetime_points = lifetime_points + $3, updated_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING lifetime_points, tier`, [account.id, dataId, points]);
  if (!row) return;
  const tier = tierFor(program.tiers, Number(row.lifetime_points))?.name ?? null;
  if (tier !== row.tier) {
    await query(`UPDATE loyalty_accounts SET tier = $3 WHERE id = $1 AND user_id = $2`, [account.id, dataId, tier]);
    void emitEvent(dataId, { type: "loyalty.tier_changed", entity: "contact", entityId: account.contact_id, data: { from: row.tier, to: tier } });
  }
}

export interface EarnInput { amountMinor: number; refKind: string; refId: string; note?: string }

/** Earn points for a paid amount. No-op (null) when the program is off or the amount earns nothing. */
export async function earnPoints(dataId: string, contactId: string, input: EarnInput): Promise<(PostResult & { points: number }) | null> {
  const program = await getProgram(dataId);
  if (!program.enabled) return null;
  const account = await getOrCreateAccount(dataId, contactId);
  const mult = tierFor(program.tiers, account.lifetime_points)?.multiplier ?? 1;
  const points = pointsForAmount(program, input.amountMinor, mult);
  if (points <= 0) return null;
  const res = await postDelta(LOYALTY_CFG, dataId, account.id, points, { kind: "earn", refKind: input.refKind, refId: input.refId, note: input.note ?? null });
  if (!res.duplicate) await bumpLifetime(dataId, account, program, points);
  return { ...res, points };
}

/** Credit points outside the purchase path (referral reward). */
export async function grantPoints(dataId: string, contactId: string, points: number, kind: "referral" | "adjust", ref: { refKind: string; refId: string }, note?: string): Promise<PostResult> {
  const program = await getProgram(dataId);
  const account = await getOrCreateAccount(dataId, contactId);
  const res = await postDelta(LOYALTY_CFG, dataId, account.id, points, { kind, refKind: ref.refKind, refId: ref.refId, note: note ?? null });
  if (!res.duplicate && kind === "referral") await bumpLifetime(dataId, account, program, points);
  return res;
}

export class LoyaltyError extends Error {
  constructor(public readonly code: "disabled" | "min_redeem" | "insufficient" | "invalid", message: string) {
    super(message);
    this.name = "LoyaltyError";
  }
}

/** Spend points. Validates the program minimum; the value-in-money conversion is `pointsValueMinor`. */
export async function redeemPoints(dataId: string, contactId: string, points: number, ref: { refKind: string; refId: string; note?: string }): Promise<PostResult & { valueMinor: number }> {
  const program = await getProgram(dataId);
  if (!program.enabled) throw new LoyaltyError("disabled", "Rewards are not enabled");
  if (!Number.isInteger(points) || points <= 0) throw new LoyaltyError("invalid", "Points must be a positive whole number");
  if (points < program.min_redeem_points) throw new LoyaltyError("min_redeem", `Minimum redemption is ${program.min_redeem_points} points`);
  const account = await getAccount(dataId, contactId);
  if (!account) throw new LoyaltyError("insufficient", "No points balance");
  try {
    const res = await postDelta(LOYALTY_CFG, dataId, account.id, -points, { kind: "redeem", refKind: ref.refKind, refId: ref.refId, note: ref.note ?? null });
    return { ...res, valueMinor: pointsValueMinor(program, points) };
  } catch (err) {
    if (err instanceof InsufficientBalanceError) throw new LoyaltyError("insufficient", `Only ${err.available} points available`);
    throw err;
  }
}

/** Return redeemed points (order cancelled). Idempotent per ref. */
export async function refundRedeemed(dataId: string, contactId: string, points: number, ref: { refKind: string; refId: string }): Promise<void> {
  const account = await getAccount(dataId, contactId);
  if (!account || points <= 0) return;
  await postDelta(LOYALTY_CFG, dataId, account.id, points, { kind: "adjust", refKind: `${ref.refKind}_refund`, refId: ref.refId, note: "Points returned" });
}

export async function adjustPoints(dataId: string, contactId: string, delta: number, note: string, actorId: string): Promise<PostResult> {
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 10_000_000) throw new LoyaltyError("invalid", "Adjustment must be a non-zero whole number");
  const account = await getOrCreateAccount(dataId, contactId);
  try {
    return await postDelta(LOYALTY_CFG, dataId, account.id, delta, { kind: "adjust", refKind: "manual", refId: randomUUID(), note: `${note} (by ${actorId})` });
  } catch (err) {
    if (err instanceof InsufficientBalanceError) throw new LoyaltyError("insufficient", `Balance is only ${err.available} points`);
    throw err;
  }
}

export interface LedgerEntryDTO { id: string; kind: LoyaltyKind; points: number; balance_after: number; ref_kind: string | null; ref_id: string | null; note: string | null; created_at: string }
export async function listLedger(dataId: string, accountId: string, limit = 50): Promise<LedgerEntryDTO[]> {
  const rows = await query<{ id: string; kind: LoyaltyKind; points: string | number; balance_after: string | number; ref_kind: string | null; ref_id: string | null; note: string | null; created_at: string | Date }>(
    `SELECT id, kind, points, balance_after, ref_kind, ref_id, note, created_at FROM loyalty_ledger WHERE user_id = $1 AND account_id = $2 ORDER BY created_at DESC, id DESC LIMIT $3`,
    [dataId, accountId, Math.min(Math.max(limit, 1), 200)]
  );
  return rows.map((r) => ({ ...r, points: Number(r.points), balance_after: Number(r.balance_after), created_at: new Date(r.created_at).toISOString() }));
}

export async function listAccounts(dataId: string, opts: { q?: string | null; limit?: number } = {}): Promise<Array<AccountDTO & { full_name: string | null; email: string | null }>> {
  const params: unknown[] = [dataId];
  let where = "a.user_id = $1";
  if (opts.q?.trim()) {
    params.push(`%${opts.q.trim().toLowerCase().replace(/[%_\\]/g, "\\$&")}%`);
    where += ` AND (lower(c.full_name) LIKE $${params.length} OR lower(c.email) LIKE $${params.length})`;
  }
  params.push(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  const rows = await query<AccountRow & { full_name: string | null; email: string | null }>(
    `SELECT a.id, a.contact_id, a.balance, a.lifetime_points, a.tier, a.updated_at, c.full_name, c.email FROM loyalty_accounts a LEFT JOIN crm_contacts c ON c.id = a.contact_id AND c.user_id = a.user_id WHERE ${where} ORDER BY a.lifetime_points DESC, a.id LIMIT $${params.length}`,
    params
  );
  return rows.map((r) => ({ ...toAccount(r), full_name: r.full_name, email: r.email }));
}

/** What a shopper/portal member can spend right now against a subtotal. */
export async function redeemQuote(dataId: string, contactId: string, subtotalMinor: number): Promise<{ balance: number; maxPoints: number; maxValueMinor: number; program: LoyaltyProgram }> {
  const program = await getProgram(dataId);
  const account = program.enabled ? await getAccount(dataId, contactId) : null;
  const balance = account?.balance ?? 0;
  const maxPoints = maxRedeemablePoints(program, balance, subtotalMinor);
  return { balance, maxPoints, maxValueMinor: pointsValueMinor(program, maxPoints), program };
}

/**
 * Cron: expire old points for programs with `expiry_months`. Idempotent per
 * (account, cutoff month) via the ledger ref.
 */
export async function expirePoints(limit = 200, now: Date = new Date()): Promise<{ accounts: number; expired: number }> {
  const programs = await query<{ user_id: string; expiry_months: number }>(`SELECT user_id, expiry_months FROM loyalty_programs WHERE enabled = TRUE AND expiry_months IS NOT NULL`).catch(() => []);
  let accounts = 0;
  let expired = 0;
  for (const p of programs) {
    if (accounts >= limit) break;
    const cutoff = new Date(now);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - Number(p.expiry_months));
    const rows = await query<AccountRow>(`SELECT ${ACCOUNT_COLS} FROM loyalty_accounts WHERE user_id = $1 AND balance > 0 ORDER BY updated_at ASC LIMIT $2`, [p.user_id, limit - accounts]);
    for (const a of rows) {
      accounts++;
      const entries = await query<{ kind: LoyaltyKind; points: string | number; created_at: string | Date }>(`SELECT kind, points, created_at FROM loyalty_ledger WHERE user_id = $1 AND account_id = $2`, [p.user_id, a.id]);
      const n = expirablePoints(entries.map((e) => ({ kind: e.kind, points: Number(e.points), created_at: e.created_at })), cutoff, Number(a.balance));
      if (n <= 0) continue;
      const res = await postDelta(LOYALTY_CFG, p.user_id, a.id, -n, { kind: "expire", refKind: "expiry", refId: `${a.id}:${cutoff.toISOString().slice(0, 7)}`, note: `Points older than ${p.expiry_months} months expired` }).catch(() => null);
      if (res && !res.duplicate) expired += n;
    }
  }
  return { accounts, expired };
}
