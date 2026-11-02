import { query } from "@/lib/dsql";
import type { LineItem } from "@/lib/money/items";
import { getInvoice, updateInvoice, type InvoiceDTO } from "@/lib/money/invoices";
import { markExpensesInvoiced, toExpenseDTO, type ExpenseDTO, type ExpenseRow } from "./expenses";
import { markTimeInvoiced, toTimeEntryDTO, type TimeEntryDTO, type TimeEntryRow } from "./time";

/**
 * Turn unbilled expenses and time entries into invoice line items on a draft
 * invoice, then mark them invoiced so they can't be billed twice.
 */

/** Pure: an expense as a line item (billed at cost incl. tax, no extra tax). */
export function expenseLineItem(e: ExpenseDTO): LineItem {
  const what = [e.vendor, e.description].filter(Boolean).join(" — ") || e.category;
  return { description: `Expense · ${what}`, qty: 1, unit_minor: e.total_minor, tax_rate_bp: 0 };
}

/**
 * Pure: a time entry as a line item. Billed as one line at the entry's exact
 * minute-based value (`value_minor`, the same figure job costing uses) so the
 * invoice total always reconciles with the time cost; the hours and rate are
 * shown in the description. (2-dp hours × rate would drift by a few minor
 * units per line, e.g. 50 min @ 100.00/h → 83.00 instead of 83.33.)
 */
export function timeLineItem(t: TimeEntryDTO): LineItem {
  const hours = Math.round(((t.minutes ?? 0) / 60) * 100) / 100;
  const day = new Date(t.started_at).toISOString().slice(0, 10);
  return {
    description: `Time · ${t.description?.trim() || "Work"} (${day}) · ${hours} h @ ${t.rate_minor} ${t.currency}/h`,
    qty: 1,
    unit_minor: t.value_minor,
    tax_rate_bp: 0,
  };
}

export interface AttachBillablesResult {
  invoice: InvoiceDTO;
  attached: { expenses: number; time_entries: number };
}

export async function attachBillables(
  dataId: string,
  invoiceId: string,
  input: { expenseIds: string[]; timeEntryIds: string[] }
): Promise<AttachBillablesResult> {
  const inv = await getInvoice(dataId, invoiceId);
  if (!inv) throw new Error("Invoice not found");
  if (inv.status !== "draft") throw new Error("Billables can only be added to a draft invoice");

  const expenses = input.expenseIds.length
    ? (await query<ExpenseRow>(
        `SELECT * FROM expenses WHERE user_id = $1 AND id = ANY($2::text[]) AND billable = TRUE AND invoice_id IS NULL ORDER BY spent_at ASC`,
        [dataId, input.expenseIds]
      )).map(toExpenseDTO)
    : [];
  const time = input.timeEntryIds.length
    ? (await query<TimeEntryRow>(
        `SELECT * FROM time_entries WHERE user_id = $1 AND id = ANY($2::text[]) AND billable = TRUE AND invoice_id IS NULL AND ended_at IS NOT NULL ORDER BY started_at ASC`,
        [dataId, input.timeEntryIds]
      )).map(toTimeEntryDTO)
    : [];
  if (expenses.length === 0 && time.length === 0) throw new Error("Nothing to bill: no unbilled billable rows matched");

  for (const e of expenses) if (e.currency.toUpperCase() !== inv.currency.toUpperCase()) throw new Error(`Currency mismatch: expense in ${e.currency}, invoice in ${inv.currency}`);
  for (const t of time) if (t.currency.toUpperCase() !== inv.currency.toUpperCase()) throw new Error(`Currency mismatch: time entry in ${t.currency}, invoice in ${inv.currency}`);

  const items: LineItem[] = [...inv.items, ...expenses.map(expenseLineItem), ...time.map(timeLineItem)];
  const updated = await updateInvoice(dataId, inv.id, { items });
  const [ne, nt] = await Promise.all([
    markExpensesInvoiced(dataId, expenses.map((e) => e.id), inv.id),
    markTimeInvoiced(dataId, time.map((t) => t.id), inv.id),
  ]);
  return { invoice: updated, attached: { expenses: ne, time_entries: nt } };
}
