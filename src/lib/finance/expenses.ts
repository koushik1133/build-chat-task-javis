import { randomUUID } from "crypto";
import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { CurrencySchema } from "@/lib/money/items";
import { emitEvent } from "@/lib/events/bus";
import { keysetClause, keysetOrder, type Cursor } from "@/lib/public-api/pagination";

/** Expenses: cash out, optionally tied to a job (ref_kind/ref_id) and billable to a client. */

export const EXPENSE_CATEGORIES = [
  "general", "materials", "subcontractor", "travel", "fuel", "equipment", "software", "marketing", "meals", "fees", "other",
] as const;

export interface ExpenseRow {
  id: string;
  user_id: string;
  category: string;
  vendor: string | null;
  description: string | null;
  amount_minor: string | number;
  currency: string;
  tax_minor: string | number;
  spent_at: string;
  receipt_url: string | null;
  ref_kind: string | null;
  ref_id: string | null;
  billable: boolean;
  invoice_id: string | null;
  created_by: string | null;
  created_at: string;
}

export interface ExpenseDTO {
  id: string;
  category: string;
  vendor: string | null;
  description: string | null;
  amount_minor: number;
  currency: string;
  tax_minor: number;
  total_minor: number;
  spent_at: string;
  receipt_url: string | null;
  ref_kind: string | null;
  ref_id: string | null;
  billable: boolean;
  invoice_id: string | null;
  created_by: string | null;
  created_at: string;
}

export function toExpenseDTO(r: ExpenseRow): ExpenseDTO {
  const amount_minor = Number(r.amount_minor);
  const tax_minor = Number(r.tax_minor);
  return {
    id: r.id,
    category: r.category,
    vendor: r.vendor,
    description: r.description,
    amount_minor,
    currency: r.currency,
    tax_minor,
    total_minor: amount_minor + tax_minor,
    spent_at: r.spent_at,
    receipt_url: r.receipt_url,
    ref_kind: r.ref_kind,
    ref_id: r.ref_id,
    billable: Boolean(r.billable),
    invoice_id: r.invoice_id,
    created_by: r.created_by,
    created_at: r.created_at,
  };
}

const RefKind = z.string().trim().min(1).max(40).regex(/^[a-z_]+$/, "ref_kind must be a lowercase slug");

export const ExpenseInputSchema = z
  .object({
    category: z.string().trim().min(1).max(40).default("general"),
    vendor: z.string().trim().max(200).nullable().optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    amount_minor: z.number().int().min(0).max(1_000_000_000_000),
    currency: CurrencySchema.default("USD"),
    tax_minor: z.number().int().min(0).max(1_000_000_000_000).default(0),
    spent_at: z.string().datetime({ offset: true }).optional(),
    receipt_url: z.string().url().max(2000).nullable().optional(),
    ref_kind: RefKind.nullable().optional(),
    ref_id: z.string().trim().max(100).nullable().optional(),
    billable: z.boolean().default(false),
  })
  .strict();
export type ExpenseInput = z.infer<typeof ExpenseInputSchema>;
export const ExpensePatchSchema = ExpenseInputSchema.partial().strict();
export type ExpensePatch = z.infer<typeof ExpensePatchSchema>;

export interface ListExpensesOpts {
  from?: string | null;
  to?: string | null;
  /** "kind:id" or separate refKind/refId. */
  ref?: string | null;
  refKind?: string | null;
  refId?: string | null;
  unbilledOnly?: boolean;
  limit?: number;
  /** "spent" (default) or "created" (newest first, cursor-friendly). */
  order?: "spent" | "created";
  cursor?: Cursor | null;
}

export function parseRef(ref: string | null | undefined): { refKind: string; refId: string } | null {
  if (!ref) return null;
  const i = ref.indexOf(":");
  if (i <= 0) return null;
  return { refKind: ref.slice(0, i), refId: ref.slice(i + 1) };
}

export async function listExpenses(dataId: string, opts: ListExpensesOpts = {}): Promise<ExpenseDTO[]> {
  const params: unknown[] = [dataId];
  let sql = `SELECT * FROM expenses WHERE user_id = $1`;
  if (opts.from) {
    params.push(opts.from);
    sql += ` AND spent_at >= $${params.length}`;
  }
  if (opts.to) {
    params.push(opts.to);
    sql += ` AND spent_at <= $${params.length}`;
  }
  const ref = parseRef(opts.ref) ?? (opts.refKind && opts.refId ? { refKind: opts.refKind, refId: opts.refId } : null);
  if (ref) {
    params.push(ref.refKind, ref.refId);
    sql += ` AND ref_kind = $${params.length - 1} AND ref_id = $${params.length}`;
  }
  if (opts.unbilledOnly) sql += ` AND billable = TRUE AND invoice_id IS NULL`;
  if (opts.order === "created") sql += keysetClause(opts.cursor, params);
  params.push(Math.min(Math.max(opts.limit ?? 200, 1), 1000));
  sql += opts.order === "created" ? ` ORDER BY ${keysetOrder()} LIMIT $${params.length}` : ` ORDER BY spent_at DESC, created_at DESC LIMIT $${params.length}`;
  return (await query<ExpenseRow>(sql, params)).map(toExpenseDTO);
}

export async function getExpense(dataId: string, id: string): Promise<ExpenseDTO | null> {
  const row = await queryOne<ExpenseRow>(`SELECT * FROM expenses WHERE id = $1 AND user_id = $2`, [id, dataId]);
  return row ? toExpenseDTO(row) : null;
}

export async function createExpense(dataId: string, input: ExpenseInput, actorId?: string | null): Promise<ExpenseDTO> {
  const id = randomUUID();
  await query(
    `INSERT INTO expenses (id, user_id, category, vendor, description, amount_minor, currency, tax_minor, spent_at, receipt_url, ref_kind, ref_id, billable, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      id, dataId, input.category, input.vendor ?? null, input.description ?? null, input.amount_minor, input.currency, input.tax_minor,
      input.spent_at ?? new Date().toISOString(), input.receipt_url ?? null, input.ref_kind ?? null, input.ref_id ?? null, input.billable, actorId ?? null,
    ]
  );
  const e = await getExpense(dataId, id);
  if (!e) throw new Error("Expense vanished after insert");
  void emitEvent(dataId, { type: "expense.created", entity: "expense", entityId: id, data: { category: e.category, vendor: e.vendor, total_minor: e.total_minor, currency: e.currency, billable: e.billable } });
  return e;
}

export async function updateExpense(dataId: string, id: string, patch: ExpensePatch): Promise<ExpenseDTO> {
  const existing = await getExpense(dataId, id);
  if (!existing) throw new Error("Expense not found");
  if (existing.invoice_id && (patch.amount_minor !== undefined || patch.tax_minor !== undefined || patch.currency !== undefined)) {
    throw new Error("Amounts cannot change after the expense was invoiced");
  }
  const sets: string[] = [];
  const params: unknown[] = [id, dataId];
  const push = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  for (const key of ["category", "vendor", "description", "amount_minor", "currency", "tax_minor", "spent_at", "receipt_url", "ref_kind", "ref_id", "billable"] as const) {
    if (patch[key] !== undefined) push(key, patch[key]);
  }
  if (sets.length === 0) return existing;
  await query(`UPDATE expenses SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2`, params);
  const out = await getExpense(dataId, id);
  if (!out) throw new Error("Expense not found");
  return out;
}

export async function deleteExpense(dataId: string, id: string): Promise<boolean> {
  const existing = await getExpense(dataId, id);
  if (!existing) return false;
  if (existing.invoice_id) throw new Error("Invoiced expenses cannot be deleted");
  await query(`DELETE FROM expenses WHERE id = $1 AND user_id = $2`, [id, dataId]);
  return true;
}

/** Mark expenses as billed on an invoice (only unbilled rows owned by this org). */
export async function markExpensesInvoiced(dataId: string, ids: string[], invoiceId: string): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await query<{ id: string }>(
    `UPDATE expenses SET invoice_id = $3 WHERE user_id = $1 AND id = ANY($2::text[]) AND invoice_id IS NULL RETURNING id`,
    [dataId, ids, invoiceId]
  );
  return rows.length;
}
