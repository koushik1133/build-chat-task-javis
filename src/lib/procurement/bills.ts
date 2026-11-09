import { randomUUID } from "crypto";
import { z } from "zod";
import { query, queryOne, withRetry } from "@/lib/dsql";
import { nextDocNumber } from "@/lib/docs/numbering";
import { emitEvent } from "@/lib/events/bus";
import { createExpense } from "@/lib/finance/expenses";
import { CurrencySchema } from "@/lib/money/items";
import { resolveDocumentTotals } from "@/lib/money/tax-rates";
import { keysetClause, keysetOrder, type Cursor } from "@/lib/public-api/pagination";
import { getPurchaseOrder, PoLinesSchema, parsePoLines, type PoLine } from "./purchase-orders";
import { getSupplier } from "./suppliers";
import { BILL_PAYMENT_METHODS, BILL_STATUSES, buildAging, deriveBillStatus, isBillOverdue, type AgingBucket, type AgingRow, type BillStatus } from "./pure";

/**
 * Supplier bills (accounts payable) and their payments.
 *
 * `recordBillPayment` is race-safe: the paid_minor bump is a conditional
 * UPDATE (`WHERE paid_minor = <what we read>`) inside withRetry, so two
 * concurrent payments can never over- or under-count. Each payment also writes
 * an `expenses` row (category "purchases", ref_kind "bill") so job costing and
 * the accounting push see the cash leaving.
 */

export interface SupplierBillRow {
  id: string;
  user_id: string;
  supplier_id: string;
  purchase_order_id: string | null;
  number: string;
  supplier_ref: string | null;
  status: BillStatus;
  items: string | null;
  subtotal_minor: string | number;
  tax_minor: string | number;
  total_minor: string | number;
  currency: string;
  issued_at: string | null;
  due_at: string | null;
  paid_minor: string | number;
  paid_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

type JoinedRow = SupplierBillRow & { supplier_name: string | null; po_number: string | null };

export interface SupplierBillDTO {
  id: string;
  supplier_id: string;
  supplier_name: string | null;
  purchase_order_id: string | null;
  po_number: string | null;
  number: string;
  supplier_ref: string | null;
  status: BillStatus;
  items: PoLine[];
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
  paid_minor: number;
  outstanding_minor: number;
  currency: string;
  issued_at: string | null;
  due_at: string | null;
  paid_at: string | null;
  overdue: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT = `SELECT b.*, s.name AS supplier_name, po.number AS po_number
  FROM supplier_bills b LEFT JOIN suppliers s ON s.id = b.supplier_id LEFT JOIN purchase_orders po ON po.id = b.purchase_order_id`;

function toDTO(r: JoinedRow): SupplierBillDTO {
  const total = Number(r.total_minor);
  const paid = Number(r.paid_minor);
  return {
    id: r.id,
    supplier_id: r.supplier_id,
    supplier_name: r.supplier_name,
    purchase_order_id: r.purchase_order_id,
    po_number: r.po_number,
    number: r.number,
    supplier_ref: r.supplier_ref,
    status: r.status,
    items: parsePoLines(r.items),
    subtotal_minor: Number(r.subtotal_minor),
    tax_minor: Number(r.tax_minor),
    total_minor: total,
    paid_minor: paid,
    outstanding_minor: Math.max(total - paid, 0),
    currency: r.currency,
    issued_at: r.issued_at,
    due_at: r.due_at,
    paid_at: r.paid_at,
    overdue: isBillOverdue({ status: r.status, due_at: r.due_at }),
    notes: r.notes,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export const SupplierBillInputSchema = z
  .object({
    supplier_id: z.string().min(1).max(100),
    purchase_order_id: z.string().max(100).nullable().optional(),
    supplier_ref: z.string().trim().max(100).nullable().optional(),
    currency: CurrencySchema.optional(),
    items: PoLinesSchema.default([]),
    issued_at: z.string().datetime({ offset: true }).nullable().optional(),
    due_at: z.string().datetime({ offset: true }).nullable().optional(),
    notes: z.string().trim().max(4000).nullable().optional(),
    /** Create directly as `open` (default) or keep as a draft. */
    status: z.enum(["draft", "open"]).default("open"),
  })
  .strict();
export type SupplierBillInput = z.infer<typeof SupplierBillInputSchema>;

export const SupplierBillPatchSchema = SupplierBillInputSchema.omit({ status: true }).partial().extend({ status: z.enum(["draft", "open", "void"]).optional() }).strict();
export type SupplierBillPatch = z.infer<typeof SupplierBillPatchSchema>;

export const BillPaymentInputSchema = z
  .object({
    amount_minor: z.number().int().min(1).max(1_000_000_000_000),
    paid_at: z.string().datetime({ offset: true }).optional(),
    method: z.enum(BILL_PAYMENT_METHODS).default("bank"),
    ref: z.string().trim().max(100).nullable().optional(),
    note: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();
export type BillPaymentInput = z.infer<typeof BillPaymentInputSchema>;

export interface ListBillsOpts {
  status?: string | null;
  supplierId?: string | null;
  overdueOnly?: boolean;
  limit?: number;
  cursor?: Cursor | null;
}

export async function listSupplierBills(dataId: string, opts: ListBillsOpts = {}): Promise<SupplierBillDTO[]> {
  const params: unknown[] = [dataId];
  let sql = `${SELECT} WHERE b.user_id = $1`;
  if (opts.status && (BILL_STATUSES as readonly string[]).includes(opts.status)) {
    params.push(opts.status);
    sql += ` AND b.status = $${params.length}`;
  }
  if (opts.supplierId) {
    params.push(opts.supplierId);
    sql += ` AND b.supplier_id = $${params.length}`;
  }
  if (opts.overdueOnly) sql += ` AND b.status IN ('open', 'partially_paid') AND b.due_at IS NOT NULL AND b.due_at < NOW()`;
  sql += keysetClause(opts.cursor, params, { alias: "b." });
  params.push(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  sql += ` ORDER BY ${keysetOrder("b.")} LIMIT $${params.length}`;
  return (await query<JoinedRow>(sql, params)).map(toDTO);
}

export async function getSupplierBill(dataId: string, id: string): Promise<SupplierBillDTO | null> {
  const row = await queryOne<JoinedRow>(`${SELECT} WHERE b.id = $1 AND b.user_id = $2`, [id, dataId]);
  return row ? toDTO(row) : null;
}

export async function createSupplierBill(dataId: string, input: SupplierBillInput): Promise<SupplierBillDTO> {
  const supplier = await getSupplier(dataId, input.supplier_id);
  if (!supplier) throw new Error("Supplier not found");
  if (input.purchase_order_id) {
    const po = await getPurchaseOrder(dataId, input.purchase_order_id);
    if (!po) throw new Error("Purchase order not found");
  }
  const id = randomUUID();
  const [totals, number] = await Promise.all([resolveDocumentTotals(dataId, input.items), nextDocNumber(dataId, "supplier_bill")]);
  const issued = input.issued_at ?? new Date().toISOString();
  const due = input.due_at ?? new Date(new Date(issued).getTime() + supplier.payment_terms_days * 86_400_000).toISOString();
  await query(
    `INSERT INTO supplier_bills (id, user_id, supplier_id, purchase_order_id, number, supplier_ref, status, items, subtotal_minor, tax_minor, total_minor, currency, issued_at, due_at, paid_minor, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 0, $15)`,
    [
      id, dataId, supplier.id, input.purchase_order_id ?? null, number, input.supplier_ref ?? null, input.status, JSON.stringify(input.items),
      totals.subtotal_minor, totals.tax_minor, totals.total_minor, (input.currency ?? supplier.currency).toUpperCase(), issued, due, input.notes ?? null,
    ]
  );
  const bill = await getSupplierBill(dataId, id);
  if (!bill) throw new Error("Bill vanished after insert");
  void emitEvent(dataId, { type: "supplier_bill.created", entity: "supplier_bill", entityId: id, data: { number, supplier_id: supplier.id, purchase_order_id: input.purchase_order_id ?? null, total_minor: bill.total_minor, currency: bill.currency, due_at: bill.due_at } });
  return bill;
}

/** Bill for everything on a PO (idempotent: an existing non-void bill for the PO is returned). */
export async function createBillFromPO(dataId: string, poId: string, opts: { supplier_ref?: string | null; due_at?: string | null } = {}): Promise<SupplierBillDTO> {
  const existing = await queryOne<JoinedRow>(`${SELECT} WHERE b.user_id = $1 AND b.purchase_order_id = $2 AND b.status <> 'void' ORDER BY b.created_at DESC LIMIT 1`, [dataId, poId]);
  if (existing) return toDTO(existing);
  const po = await getPurchaseOrder(dataId, poId);
  if (!po) throw new Error("Purchase order not found");
  if (po.status === "cancelled") throw new Error("Purchase order is cancelled");
  if (po.items.length === 0) throw new Error("Purchase order has no line items");
  return createSupplierBill(dataId, {
    supplier_id: po.supplier_id,
    purchase_order_id: po.id,
    supplier_ref: opts.supplier_ref ?? null,
    currency: po.currency,
    items: po.items,
    due_at: opts.due_at ?? null,
    notes: po.notes,
    status: "open",
  });
}

export async function updateSupplierBill(dataId: string, id: string, patch: SupplierBillPatch): Promise<SupplierBillDTO> {
  const bill = await getSupplierBill(dataId, id);
  if (!bill) throw new Error("Bill not found");
  if (bill.status === "void" || bill.status === "paid") throw new Error(`Bill is ${bill.status} and cannot be edited`);
  if (patch.items && bill.paid_minor > 0) throw new Error("Line items cannot change after a payment was recorded");
  const sets: string[] = ["updated_at = NOW()"];
  const params: unknown[] = [id, dataId];
  const push = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.supplier_id !== undefined) {
    if (!(await getSupplier(dataId, patch.supplier_id))) throw new Error("Supplier not found");
    push("supplier_id", patch.supplier_id);
  }
  if (patch.purchase_order_id !== undefined) push("purchase_order_id", patch.purchase_order_id);
  if (patch.supplier_ref !== undefined) push("supplier_ref", patch.supplier_ref);
  if (patch.currency !== undefined) push("currency", patch.currency.toUpperCase());
  if (patch.issued_at !== undefined) push("issued_at", patch.issued_at);
  if (patch.due_at !== undefined) push("due_at", patch.due_at);
  if (patch.notes !== undefined) push("notes", patch.notes);
  if (patch.status !== undefined) {
    if (patch.status === "void" && bill.paid_minor > 0) throw new Error("A bill with payments cannot be voided");
    if (patch.status === "draft" && bill.status !== "draft") throw new Error("An open bill cannot go back to draft");
    push("status", patch.status);
  }
  if (patch.items) {
    const t = await resolveDocumentTotals(dataId, patch.items);
    push("items", JSON.stringify(patch.items));
    push("subtotal_minor", t.subtotal_minor);
    push("tax_minor", t.tax_minor);
    push("total_minor", t.total_minor);
  }
  await query(`UPDATE supplier_bills SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2`, params);
  const out = await getSupplierBill(dataId, id);
  if (!out) throw new Error("Bill not found");
  return out;
}

// ── payments ──────────────────────────────────────────────────────────────────

export interface BillPaymentRow {
  id: string;
  user_id: string;
  bill_id: string;
  amount_minor: string | number;
  currency: string;
  paid_at: string;
  method: string | null;
  ref: string | null;
  note: string | null;
  expense_id: string | null;
  created_by: string | null;
  created_at: string;
}

export interface BillPaymentDTO {
  id: string;
  bill_id: string;
  amount_minor: number;
  currency: string;
  paid_at: string;
  method: string | null;
  ref: string | null;
  note: string | null;
  expense_id: string | null;
  created_by: string | null;
  created_at: string;
}

function toPaymentDTO(r: BillPaymentRow): BillPaymentDTO {
  return { id: r.id, bill_id: r.bill_id, amount_minor: Number(r.amount_minor), currency: r.currency, paid_at: r.paid_at, method: r.method, ref: r.ref, note: r.note, expense_id: r.expense_id, created_by: r.created_by, created_at: r.created_at };
}

export async function listBillPayments(dataId: string, billId: string): Promise<BillPaymentDTO[]> {
  const rows = await query<BillPaymentRow>(`SELECT * FROM bill_payments WHERE user_id = $1 AND bill_id = $2 ORDER BY paid_at ASC, created_at ASC`, [dataId, billId]);
  return rows.map(toPaymentDTO);
}

class PaidRace extends Error {
  code = "40001";
  constructor() {
    super("bill paid_minor race (OC000)");
  }
}

export async function recordBillPayment(dataId: string, billId: string, input: BillPaymentInput, actorId?: string | null): Promise<{ bill: SupplierBillDTO; payment: BillPaymentDTO }> {
  const bill = await getSupplierBill(dataId, billId);
  if (!bill) throw new Error("Bill not found");
  if (bill.status === "void") throw new Error("Bill is void");
  if (bill.status === "draft") throw new Error("Open the bill before recording a payment");
  if (bill.status === "paid") throw new Error("Bill is already paid");
  if (input.amount_minor > bill.outstanding_minor) throw new Error(`Payment exceeds the outstanding balance (${bill.outstanding_minor})`);

  const paidAt = input.paid_at ?? new Date().toISOString();
  const paymentId = randomUUID();

  const next = await withRetry(async () => {
    const cur = await queryOne<{ paid_minor: string | number; total_minor: string | number; status: BillStatus }>(
      `SELECT paid_minor, total_minor, status FROM supplier_bills WHERE id = $1 AND user_id = $2`,
      [billId, dataId]
    );
    if (!cur) throw new Error("Bill not found");
    if (cur.status !== "open" && cur.status !== "partially_paid") throw new Error(`Bill is ${cur.status}`);
    const paid = Number(cur.paid_minor);
    const total = Number(cur.total_minor);
    if (paid + input.amount_minor > total) throw new Error(`Payment exceeds the outstanding balance (${Math.max(total - paid, 0)})`);
    const newPaid = paid + input.amount_minor;
    const status = deriveBillStatus({ status: cur.status, total_minor: total, paid_minor: newPaid });
    const rows = await query<{ id: string }>(
      `UPDATE supplier_bills SET paid_minor = $3, status = $4, paid_at = CASE WHEN $4 = 'paid' THEN COALESCE(paid_at, $5::timestamptz) ELSE paid_at END, updated_at = NOW()
        WHERE id = $1 AND user_id = $2 AND paid_minor = $6 RETURNING id`,
      [billId, dataId, newPaid, status, paidAt, paid]
    );
    if (rows.length === 0) throw new PaidRace();
    return { status, newPaid };
  }, 6);

  // Cash out for job costing / accounting. Failure here must not undo the payment itself.
  let expenseId: string | null = null;
  try {
    const e = await createExpense(
      dataId,
      {
        category: "purchases",
        vendor: bill.supplier_name,
        description: `Payment on bill ${bill.number}${bill.supplier_ref ? ` (${bill.supplier_ref})` : ""}`,
        amount_minor: input.amount_minor,
        currency: bill.currency,
        tax_minor: 0,
        spent_at: paidAt,
        ref_kind: "bill",
        ref_id: bill.id,
        billable: false,
      },
      actorId ?? null
    );
    expenseId = e.id;
  } catch (err) {
    console.error(`[bills] expense row for payment on ${bill.id} failed:`, err);
  }

  await query(
    `INSERT INTO bill_payments (id, user_id, bill_id, amount_minor, currency, paid_at, method, ref, note, expense_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [paymentId, dataId, billId, input.amount_minor, bill.currency, paidAt, input.method, input.ref ?? null, input.note ?? null, expenseId, actorId ?? null]
  );

  if (next.status === "paid") {
    void emitEvent(dataId, { type: "supplier_bill.paid", entity: "supplier_bill", entityId: billId, data: { number: bill.number, supplier_id: bill.supplier_id, total_minor: bill.total_minor, currency: bill.currency, purchase_order_id: bill.purchase_order_id } });
  }
  const out = await getSupplierBill(dataId, billId);
  const payment = await queryOne<BillPaymentRow>(`SELECT * FROM bill_payments WHERE id = $1`, [paymentId]);
  if (!out || !payment) throw new Error("Payment vanished after insert");
  return { bill: out, payment: toPaymentDTO(payment) };
}

// ── AP aging ──────────────────────────────────────────────────────────────────

export interface ApAging {
  as_of: string;
  rows: AgingRow[];
  totals: Record<AgingBucket, number>;
  total_minor: number;
  /** Distinct currencies in play (totals mix them when more than one). */
  currencies: string[];
}

export async function apAging(dataId: string, now = Date.now()): Promise<ApAging> {
  const rows = await query<{ supplier_id: string; supplier_name: string | null; currency: string; total_minor: string | number; paid_minor: string | number; due_at: string | null }>(
    `SELECT b.supplier_id, s.name AS supplier_name, b.currency, b.total_minor, b.paid_minor, b.due_at
       FROM supplier_bills b LEFT JOIN suppliers s ON s.id = b.supplier_id
      WHERE b.user_id = $1 AND b.status IN ('open', 'partially_paid')`,
    [dataId]
  );
  const aging = buildAging(
    rows.map((r) => ({ supplier_id: r.supplier_id, supplier_name: r.supplier_name ?? "Unknown supplier", currency: r.currency, total_minor: Number(r.total_minor), paid_minor: Number(r.paid_minor), due_at: r.due_at })),
    now
  );
  return { as_of: new Date(now).toISOString(), ...aging, currencies: [...new Set(aging.rows.map((r) => r.currency))] };
}
