import { randomBytes, randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";
import { grantPoints } from "./loyalty";
import { DEFAULT_REFERRAL_POLICY, isSelfReferral, referralGuard, type ReferralBlock, type ReferralPolicy } from "./pure";

/**
 * Referrals. Each contact has a stable code (`referral_codes`). A referee who
 * arrives with `?ref=CODE` is recorded as a pending referral at checkout; the
 * referrer is rewarded (points) when the referee's first paid order/invoice
 * qualifies. Guards: self-referral (same contact/email/phone), one reward per
 * referee (unique index + status), and a monthly cap per referrer.
 */

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = () => {
  const b = randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[b[i] % 32];
  return s;
};

export const REF_PARAM_RE = /^[A-Za-z0-9]{6,12}$/;

export async function getOrCreateReferralCode(dataId: string, contactId: string): Promise<string> {
  const existing = await queryOne<{ code: string }>(`SELECT code FROM referral_codes WHERE user_id = $1 AND contact_id = $2`, [dataId, contactId]);
  if (existing) return existing.code;
  const contact = await queryOne(`SELECT id FROM crm_contacts WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, [contactId, dataId]);
  if (!contact) throw new Error("Contact not found");
  for (let i = 0; i < 5; i++) {
    try {
      const code = newCode();
      await query(`INSERT INTO referral_codes (id, user_id, contact_id, code) VALUES ($1,$2,$3,$4)`, [randomUUID(), dataId, contactId, code]);
      return code;
    } catch (err) {
      const c = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
      if (c !== "23505") throw err;
      const again = await queryOne<{ code: string }>(`SELECT code FROM referral_codes WHERE user_id = $1 AND contact_id = $2`, [dataId, contactId]);
      if (again) return again.code;
    }
  }
  throw new Error("Could not allocate a referral code");
}

interface Party { id: string; email: string | null; phone: string | null }
async function loadParty(dataId: string, id: string): Promise<Party | null> {
  return queryOne<Party>(`SELECT id, email, phone FROM crm_contacts WHERE id = $1 AND user_id = $2`, [id, dataId]);
}

export type CaptureResult = { ok: true; referralId: string } | { ok: false; reason: "unknown_code" | "self_referral" | "already_referred" | "returning_customer" };

/** Record that `referee` arrived via `code`. Safe to call repeatedly: one referral per referee. */
export async function captureReferral(dataId: string, input: { code: string; refereeContactId: string; policy?: ReferralPolicy }): Promise<CaptureResult> {
  const code = input.code.trim().toUpperCase();
  if (!REF_PARAM_RE.test(code)) return { ok: false, reason: "unknown_code" };
  const owner = await queryOne<{ contact_id: string }>(`SELECT contact_id FROM referral_codes WHERE user_id = $1 AND code = $2`, [dataId, code]);
  if (!owner) return { ok: false, reason: "unknown_code" };
  const [referrer, referee] = await Promise.all([loadParty(dataId, owner.contact_id), loadParty(dataId, input.refereeContactId)]);
  if (!referrer || !referee) return { ok: false, reason: "unknown_code" };
  if (isSelfReferral(referrer, referee)) return { ok: false, reason: "self_referral" };
  const existing = await queryOne(`SELECT id FROM referrals WHERE user_id = $1 AND referee_contact_id = $2`, [dataId, referee.id]);
  if (existing) return { ok: false, reason: "already_referred" };
  const prior = await queryOne(`SELECT id FROM invoices WHERE user_id = $1 AND contact_id = $2 AND status = 'paid' LIMIT 1`, [dataId, referee.id]);
  if (prior) return { ok: false, reason: "returning_customer" };
  const id = randomUUID();
  try {
    await query(`INSERT INTO referrals (id, user_id, referrer_contact_id, code, referee_contact_id, status, reward_points) VALUES ($1,$2,$3,$4,$5,'pending',$6)`, [id, dataId, owner.contact_id, code, referee.id, (input.policy ?? DEFAULT_REFERRAL_POLICY).reward_points]);
  } catch (err) {
    const c = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
    if (c === "23505") return { ok: false, reason: "already_referred" };
    throw err;
  }
  return { ok: true, referralId: id };
}

export type QualifyResult = { rewarded: true; points: number } | { rewarded: false; reason: ReferralBlock | "no_referral" };

/** Called when the referee pays: reward the referrer once. */
export async function qualifyReferral(dataId: string, refereeContactId: string, amountMinor: number, policy: ReferralPolicy = DEFAULT_REFERRAL_POLICY, now: Date = new Date()): Promise<QualifyResult> {
  const ref = await queryOne<{ id: string; referrer_contact_id: string; status: string; reward_points: number }>(`SELECT id, referrer_contact_id, status, reward_points FROM referrals WHERE user_id = $1 AND referee_contact_id = $2`, [dataId, refereeContactId]);
  if (!ref || ref.status === "void") return { rewarded: false, reason: "no_referral" };
  const [referrer, referee] = await Promise.all([loadParty(dataId, ref.referrer_contact_id), loadParty(dataId, refereeContactId)]);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const cap = await queryOne<{ n: string }>(`SELECT COUNT(*) AS n FROM referrals WHERE user_id = $1 AND referrer_contact_id = $2 AND status = 'rewarded' AND qualified_at >= $3`, [dataId, ref.referrer_contact_id, monthStart]);
  const block = referralGuard({
    self: !referrer || !referee ? true : isSelfReferral(referrer, referee),
    refereeAlreadyRewarded: ref.status === "rewarded",
    rewardedThisMonth: Number(cap?.n ?? 0),
    amountMinor,
    policy,
  });
  if (block === "self_referral") await query(`UPDATE referrals SET status = 'void' WHERE id = $1 AND user_id = $2`, [ref.id, dataId]);
  if (block) return { rewarded: false, reason: block };
  // Claim first (pending -> qualified) so concurrent paid hooks reward once.
  const claimed = await query<{ id: string }>(`UPDATE referrals SET status = 'qualified', qualified_at = NOW() WHERE id = $1 AND user_id = $2 AND status = 'pending' RETURNING id`, [ref.id, dataId]);
  if (claimed.length === 0) return { rewarded: false, reason: "already_rewarded" };
  const points = Number(ref.reward_points);
  try {
    if (points > 0) await grantPoints(dataId, ref.referrer_contact_id, points, "referral", { refKind: "referral", refId: ref.id }, "Referral reward");
    await query(`UPDATE referrals SET status = 'rewarded' WHERE id = $1 AND user_id = $2`, [ref.id, dataId]);
  } catch (err) {
    await query(`UPDATE referrals SET status = 'pending', qualified_at = NULL WHERE id = $1 AND user_id = $2 AND status = 'qualified'`, [ref.id, dataId]).catch(() => undefined);
    throw err;
  }
  void emitEvent(dataId, { type: "referral.rewarded", entity: "contact", entityId: ref.referrer_contact_id, data: { referral_id: ref.id, referee_contact_id: refereeContactId, points } });
  return { rewarded: true, points };
}

export interface ReferralDTO { id: string; referrer_contact_id: string; referrer_name: string | null; referee_contact_id: string | null; referee_name: string | null; code: string; status: string; reward_points: number; qualified_at: string | null; created_at: string }
export async function listReferrals(dataId: string, opts: { status?: string | null; limit?: number } = {}): Promise<ReferralDTO[]> {
  const params: unknown[] = [dataId];
  let where = "r.user_id = $1";
  if (opts.status) { params.push(opts.status); where += ` AND r.status = $${params.length}`; }
  params.push(Math.min(Math.max(opts.limit ?? 100, 1), 200));
  const rows = await query<{ id: string; referrer_contact_id: string; referrer_name: string | null; referee_contact_id: string | null; referee_name: string | null; code: string; status: string; reward_points: number; qualified_at: string | Date | null; created_at: string | Date }>(
    `SELECT r.id, r.referrer_contact_id, a.full_name AS referrer_name, r.referee_contact_id, b.full_name AS referee_name, r.code, r.status, r.reward_points, r.qualified_at, r.created_at
       FROM referrals r LEFT JOIN crm_contacts a ON a.id = r.referrer_contact_id AND a.user_id = r.user_id LEFT JOIN crm_contacts b ON b.id = r.referee_contact_id AND b.user_id = r.user_id
      WHERE ${where} ORDER BY r.created_at DESC, r.id DESC LIMIT $${params.length}`,
    params
  );
  return rows.map((r) => ({ ...r, reward_points: Number(r.reward_points), qualified_at: r.qualified_at ? new Date(r.qualified_at).toISOString() : null, created_at: new Date(r.created_at).toISOString() }));
}
