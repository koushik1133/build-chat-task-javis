import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";
import { evaluateVoucher, type DiscountItem, type VoucherEvaluation, type VoucherInput, type VoucherLike } from "./pure";

/** Vouchers / discount codes: CRUD, validation against a context, idempotent redemption. */

export interface VoucherDTO extends VoucherLike {
  name: string;
  created_at: string;
}
interface Row {
  id: string; code_upper: string; name: string; kind: VoucherLike["kind"]; value: number; currency: string | null; min_subtotal_minor: string | number;
  max_uses: number | null; per_contact_limit: number | null; used_count: number; starts_at: string | Date | null; ends_at: string | Date | null;
  applies_to: VoucherLike["applies_to"]; applies_config: string | null; stackable: boolean; active: boolean; created_at: string | Date;
}
const COLS = "id, code_upper, name, kind, value, currency, min_subtotal_minor, max_uses, per_contact_limit, used_count, starts_at, ends_at, applies_to, applies_config, stackable, active, created_at";
const iso = (v: string | Date | null) => (v ? new Date(v).toISOString() : null);

export function toVoucherDTO(r: Row): VoucherDTO {
  let cfg: VoucherLike["applies_config"] = null;
  try { cfg = r.applies_config ? (JSON.parse(r.applies_config) as VoucherLike["applies_config"]) : null; } catch { cfg = null; }
  return { id: r.id, code_upper: r.code_upper, name: r.name, kind: r.kind, value: Number(r.value), currency: r.currency, min_subtotal_minor: Number(r.min_subtotal_minor), max_uses: r.max_uses === null ? null : Number(r.max_uses), per_contact_limit: r.per_contact_limit === null ? null : Number(r.per_contact_limit), used_count: Number(r.used_count), starts_at: iso(r.starts_at), ends_at: iso(r.ends_at), applies_to: r.applies_to, applies_config: cfg, stackable: Boolean(r.stackable), active: Boolean(r.active), created_at: iso(r.created_at) ?? "" };
}

export const normalizeCode = (c: string) => c.trim().toUpperCase();

export async function createVoucher(dataId: string, input: VoucherInput): Promise<VoucherDTO> {
  const id = randomUUID();
  try {
    await query(
      `INSERT INTO vouchers (id, user_id, code_upper, name, kind, value, currency, min_subtotal_minor, max_uses, per_contact_limit, used_count, starts_at, ends_at, applies_to, applies_config, stackable, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$12,$13,$14,$15,$16)`,
      [id, dataId, normalizeCode(input.code), input.name, input.kind, input.value, input.currency ?? null, input.min_subtotal_minor ?? 0, input.max_uses ?? null, input.per_contact_limit ?? null, input.starts_at ?? null, input.ends_at ?? null, input.applies_to ?? "all", input.applies_config ? JSON.stringify(input.applies_config) : null, input.stackable ?? false, input.active ?? true]
    );
  } catch (err) {
    const c = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
    if (c === "23505") throw new Error("A voucher with this code already exists");
    throw err;
  }
  const v = await getVoucher(dataId, id);
  if (!v) throw new Error("Voucher vanished after insert");
  return v;
}

export async function updateVoucher(dataId: string, id: string, patch: Partial<VoucherInput>): Promise<VoucherDTO> {
  const cur = await getVoucher(dataId, id);
  if (!cur) throw new Error("Voucher not found");
  const m = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Record<string, unknown>;
  await query(
    `UPDATE vouchers SET name=$3, kind=$4, value=$5, currency=$6, min_subtotal_minor=$7, max_uses=$8, per_contact_limit=$9, starts_at=$10, ends_at=$11, applies_to=$12, applies_config=$13, stackable=$14, active=$15, updated_at=NOW() WHERE id=$1 AND user_id=$2`,
    [id, dataId, m.name, m.kind, m.value, m.currency ?? null, m.min_subtotal_minor, m.max_uses ?? null, m.per_contact_limit ?? null, m.starts_at ?? null, m.ends_at ?? null, m.applies_to, m.applies_config ? JSON.stringify(m.applies_config) : null, m.stackable, m.active]
  );
  return (await getVoucher(dataId, id)) as VoucherDTO;
}

export async function getVoucher(dataId: string, id: string): Promise<VoucherDTO | null> {
  const r = await queryOne<Row>(`SELECT ${COLS} FROM vouchers WHERE id = $1 AND user_id = $2`, [id, dataId]);
  return r ? toVoucherDTO(r) : null;
}
export async function getVoucherByCode(dataId: string, code: string): Promise<VoucherDTO | null> {
  const r = await queryOne<Row>(`SELECT ${COLS} FROM vouchers WHERE user_id = $1 AND code_upper = $2`, [dataId, normalizeCode(code)]);
  return r ? toVoucherDTO(r) : null;
}
export async function listVouchers(dataId: string, opts: { limit?: number; q?: string | null } = {}): Promise<VoucherDTO[]> {
  const params: unknown[] = [dataId];
  let where = "user_id = $1";
  if (opts.q?.trim()) { params.push(`%${opts.q.trim().toUpperCase().replace(/[%_\\]/g, "\\$&")}%`); where += ` AND (code_upper LIKE $${params.length} OR upper(name) LIKE $${params.length})`; }
  params.push(Math.min(Math.max(opts.limit ?? 100, 1), 200));
  const rows = await query<Row>(`SELECT ${COLS} FROM vouchers WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`, params);
  return rows.map(toVoucherDTO);
}

export async function contactUses(dataId: string, voucherId: string, contactId: string | null): Promise<number> {
  if (!contactId) return 0;
  const r = await queryOne<{ n: string }>(`SELECT COUNT(*) AS n FROM voucher_redemptions WHERE user_id = $1 AND voucher_id = $2 AND contact_id = $3`, [dataId, voucherId, contactId]);
  return Number(r?.n ?? 0);
}

export interface ValidateContext {
  currency: string;
  subtotalMinor: number;
  items: readonly DiscountItem[];
  contactId?: string | null;
  now?: Date;
}
export type VoucherValidation = { voucher: VoucherDTO; evaluation: VoucherEvaluation } | { voucher: null; evaluation: { ok: false; reason: "inactive"; message: string } };

/** Validate one code against a cart/invoice context. Unknown codes return the same generic rejection as inactive ones. */
export async function validateVoucher(dataId: string, code: string, ctx: ValidateContext): Promise<VoucherValidation> {
  const v = await getVoucherByCode(dataId, code);
  if (!v) return { voucher: null, evaluation: { ok: false, reason: "inactive", message: "This code is not valid." } };
  const uses = await contactUses(dataId, v.id, ctx.contactId ?? null);
  return { voucher: v, evaluation: evaluateVoucher(v, { now: ctx.now ?? new Date(), currency: ctx.currency, subtotalMinor: ctx.subtotalMinor, items: ctx.items, contactUses: uses }) };
}

/**
 * Record a redemption for an order/invoice. Idempotent on (voucher, entity); the
 * used_count increment is conditional on max_uses so two concurrent checkouts
 * can never oversell a capped code.
 */
export async function recordRedemption(dataId: string, voucher: VoucherDTO, entity: { kind: string; id: string }, contactId: string | null, amountMinor: number): Promise<boolean> {
  const dup = await queryOne(`SELECT id FROM voucher_redemptions WHERE voucher_id = $1 AND entity_kind = $2 AND entity_id = $3`, [voucher.id, entity.kind, entity.id]);
  if (dup) return false;
  const claimed = await query<{ id: string }>(`UPDATE vouchers SET used_count = used_count + 1, updated_at = NOW() WHERE id = $1 AND user_id = $2 AND (max_uses IS NULL OR used_count < max_uses) RETURNING id`, [voucher.id, dataId]);
  if (claimed.length === 0) throw new Error("This code has been fully redeemed.");
  try {
    await query(`INSERT INTO voucher_redemptions (id, user_id, voucher_id, contact_id, entity_kind, entity_id, amount_minor) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [randomUUID(), dataId, voucher.id, contactId, entity.kind, entity.id, amountMinor]);
  } catch (err) {
    await query(`UPDATE vouchers SET used_count = used_count - 1 WHERE id = $1 AND user_id = $2`, [voucher.id, dataId]).catch(() => undefined);
    const c = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
    if (c === "23505") return false;
    throw err;
  }
  void emitEvent(dataId, { type: "voucher.redeemed", entity: "voucher", entityId: voucher.id, data: { code: voucher.code_upper, entity_kind: entity.kind, entity_id: entity.id, amount_minor: amountMinor } });
  return true;
}

/** Undo a redemption (order cancelled before payment). */
export async function releaseRedemptions(dataId: string, entity: { kind: string; id: string }): Promise<number> {
  const rows = await query<{ voucher_id: string }>(`DELETE FROM voucher_redemptions WHERE user_id = $1 AND entity_kind = $2 AND entity_id = $3 RETURNING voucher_id`, [dataId, entity.kind, entity.id]);
  for (const r of rows) await query(`UPDATE vouchers SET used_count = CASE WHEN used_count > 0 THEN used_count - 1 ELSE 0 END WHERE id = $1 AND user_id = $2`, [r.voucher_id, dataId]);
  return rows.length;
}

/** Single-use personal voucher (referral reward, win-back). */
export async function issuePersonalVoucher(dataId: string, input: { name: string; kind: "percent" | "fixed"; value: number; currency?: string | null; endsInDays?: number; codePrefix?: string }): Promise<VoucherDTO> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  return createVoucher(dataId, {
    code: `${input.codePrefix ?? "THANKS"}-${suffix}`,
    name: input.name,
    kind: input.kind,
    value: input.value,
    currency: input.kind === "fixed" ? (input.currency ?? "USD") : null,
    max_uses: 1,
    per_contact_limit: 1,
    ends_at: input.endsInDays ? new Date(Date.now() + input.endsInDays * 86_400_000).toISOString() : null,
    stackable: false,
    active: true,
  });
}
