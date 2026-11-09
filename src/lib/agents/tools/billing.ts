import { z } from "zod";
import { registerTool } from "@/lib/agents/registry";
import type { ToolResult } from "@/lib/agents/types";
import { LineItemsSchema, CurrencySchema } from "@/lib/money/items";
import { createQuote, listQuotes, sendQuote } from "@/lib/money/quotes";
import { createInvoice, listInvoices } from "@/lib/money/invoices";
import { SCHEDULE_INTERVALS, createSchedule } from "@/lib/money/recurring";
import { createCreditNote } from "@/lib/money/credit-notes";
import { buildStatement } from "@/lib/money/statements";

/** Billing tools: quotes and invoices. Money is minor units + ISO currency. */

function fail(error: string): ToolResult {
  return { ok: false, summary: error, error };
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const ITEMS_PARAM = {
  type: "array",
  description: "Line items. unit_minor is in minor units (cents); tax_rate_bp is basis points (1000 = 10%).",
  items: {
    type: "object",
    properties: {
      description: { type: "string" },
      qty: { type: "number" },
      unit_minor: { type: "integer" },
      tax_rate_bp: { type: "integer" },
    },
    required: ["description", "qty", "unit_minor"],
  },
};

/* ---------- billing.list_quotes ---------- */
const ListQuotesInput = z.object({
  status: z.enum(["draft", "sent", "viewed", "accepted", "declined", "expired"]).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
registerTool<z.infer<typeof ListQuotesInput>>({
  name: "billing.list_quotes",
  module: "billing",
  description: "List quotes (newest first), optionally filtered by status.",
  input: ListQuotesInput,
  parameters: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["draft", "sent", "viewed", "accepted", "declined", "expired"] },
      limit: { type: "integer" },
    },
  },
  scope: "read",
  preview: (i) => `List quotes${i.status ? ` (${i.status})` : ""}`,
  async run(ctx, input) {
    try {
      const quotes = await listQuotes(ctx.userId, { status: input.status, limit: input.limit ?? 25 });
      return { ok: true, data: quotes, summary: `Found ${quotes.length} quote(s)` };
    } catch (err) {
      return fail(`List failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- billing.draft_quote ---------- */
const DraftQuoteInput = z.object({
  contact_id: z.string().max(100).optional(),
  currency: CurrencySchema.optional(),
  items: LineItemsSchema.min(1),
  valid_days: z.number().int().min(1).max(365).optional(),
  notes: z.string().max(4000).optional(),
});
registerTool<z.infer<typeof DraftQuoteInput>>({
  name: "billing.draft_quote",
  module: "billing",
  description: "Create a draft quote for a CRM contact with line items. Does not send it.",
  input: DraftQuoteInput,
  parameters: {
    type: "object",
    properties: {
      contact_id: { type: "string", description: "CRM contact id (from crm.search_contacts)" },
      currency: { type: "string", description: "ISO 4217, e.g. USD" },
      items: ITEMS_PARAM,
      valid_days: { type: "integer", description: "Days until the quote expires (default 30)" },
      notes: { type: "string" },
    },
    required: ["items"],
  },
  scope: "write",
  requiresApproval: true,
  preview: (i) => `Draft a quote with ${i.items.length} line item(s)${i.contact_id ? ` for contact ${i.contact_id}` : ""}`,
  async run(ctx, input) {
    try {
      const q = await createQuote(ctx.userId, {
        contact_id: input.contact_id ?? null,
        currency: input.currency,
        items: input.items,
        valid_until: new Date(Date.now() + (input.valid_days ?? 30) * 86_400_000).toISOString(),
        notes: input.notes ?? null,
      });
      return { ok: true, data: q, summary: `Drafted quote ${q.number} (${q.total_minor} ${q.currency} minor units)` };
    } catch (err) {
      return fail(`Draft failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- billing.send_quote ---------- */
const SendQuoteInput = z.object({
  quote_id: z.string().min(1),
  to: z.string().email().optional(),
  message: z.string().max(2000).optional(),
});
registerTool<z.infer<typeof SendQuoteInput>>({
  name: "billing.send_quote",
  module: "billing",
  description: "Email a quote to the client with a secure link they can review and accept online.",
  input: SendQuoteInput,
  parameters: {
    type: "object",
    properties: {
      quote_id: { type: "string" },
      to: { type: "string", description: "Override recipient email (defaults to the contact's email)" },
      message: { type: "string", description: "Personal note placed above the standard email body" },
    },
    required: ["quote_id"],
  },
  scope: "write",
  requiresApproval: true,
  preview: (i) => `Send quote ${i.quote_id}${i.to ? ` to ${i.to}` : ""}`,
  async run(ctx, input) {
    try {
      const out = await sendQuote(ctx.userId, input.quote_id, { to: input.to, message: input.message });
      return { ok: true, data: { number: out.quote.number, status: out.quote.status, url: out.url }, summary: `Sent quote ${out.quote.number}` };
    } catch (err) {
      return fail(`Send failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- billing.list_invoices ---------- */
const ListInvoicesInput = z.object({
  status: z.enum(["draft", "sent", "partially_paid", "paid", "void", "overdue"]).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
registerTool<z.infer<typeof ListInvoicesInput>>({
  name: "billing.list_invoices",
  module: "billing",
  description: "List invoices (newest first), optionally filtered by status.",
  input: ListInvoicesInput,
  parameters: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["draft", "sent", "partially_paid", "paid", "void", "overdue"] },
      limit: { type: "integer" },
    },
  },
  scope: "read",
  preview: (i) => `List invoices${i.status ? ` (${i.status})` : ""}`,
  async run(ctx, input) {
    try {
      const invoices = await listInvoices(ctx.userId, { status: input.status, limit: input.limit ?? 25 });
      return { ok: true, data: invoices, summary: `Found ${invoices.length} invoice(s)` };
    } catch (err) {
      return fail(`List failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- billing.create_invoice ---------- */
const CreateInvoiceInput = z.object({
  contact_id: z.string().max(100).optional(),
  quote_id: z.string().max(100).optional(),
  currency: CurrencySchema.optional(),
  items: LineItemsSchema.min(1),
  due_days: z.number().int().min(0).max(365).optional(),
  notes: z.string().max(4000).optional(),
});
registerTool<z.infer<typeof CreateInvoiceInput>>({
  name: "billing.create_invoice",
  module: "billing",
  description: "Create a draft invoice with line items (optionally linked to a quote and contact).",
  input: CreateInvoiceInput,
  parameters: {
    type: "object",
    properties: {
      contact_id: { type: "string" },
      quote_id: { type: "string" },
      currency: { type: "string" },
      items: ITEMS_PARAM,
      due_days: { type: "integer", description: "Days until due (default 14)" },
      notes: { type: "string" },
    },
    required: ["items"],
  },
  scope: "write",
  requiresApproval: true,
  preview: (i) => `Create an invoice with ${i.items.length} line item(s)`,
  async run(ctx, input) {
    try {
      const inv = await createInvoice(ctx.userId, {
        contact_id: input.contact_id ?? null,
        quote_id: input.quote_id ?? null,
        currency: input.currency,
        items: input.items,
        due_at: new Date(Date.now() + (input.due_days ?? 14) * 86_400_000).toISOString(),
        notes: input.notes ?? null,
      });
      return { ok: true, data: inv, summary: `Created invoice ${inv.number}` };
    } catch (err) {
      return fail(`Create failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- billing.create_recurring ---------- */
const CreateRecurringInput = z.object({
  name: z.string().trim().min(1).max(120),
  contact_id: z.string().max(100).optional(),
  currency: CurrencySchema.optional(),
  items: LineItemsSchema.min(1),
  interval: z.enum(SCHEDULE_INTERVALS as [string, ...string[]]).optional(),
  interval_count: z.number().int().min(1).max(52).optional(),
  day_of_month: z.number().int().min(1).max(31).optional(),
  first_run_at: z.string().datetime({ offset: true }).optional(),
  auto_send: z.boolean().optional(),
  terms_days: z.number().int().min(0).max(365).optional(),
});
registerTool<z.infer<typeof CreateRecurringInput>>({
  name: "billing.create_recurring",
  module: "billing",
  description: "Create a recurring invoice schedule (weekly/monthly/quarterly/yearly) that generates invoices automatically.",
  input: CreateRecurringInput,
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Schedule name, e.g. 'Monthly retainer'" },
      contact_id: { type: "string" },
      currency: { type: "string" },
      items: ITEMS_PARAM,
      interval: { type: "string", enum: [...SCHEDULE_INTERVALS] },
      interval_count: { type: "integer", description: "Every N intervals (default 1)" },
      day_of_month: { type: "integer", description: "Anchor day for monthly/quarterly/yearly (clamped to month end)" },
      first_run_at: { type: "string", description: "ISO date-time of the first invoice (default: now)" },
      auto_send: { type: "boolean", description: "Email each invoice to the contact when created" },
      terms_days: { type: "integer", description: "Payment terms in days" },
    },
    required: ["name", "items"],
  },
  scope: "write",
  requiresApproval: true,
  preview: (i) => `Create ${i.interval ?? "monthly"} recurring invoice "${i.name}" with ${i.items.length} line item(s)`,
  async run(ctx, input) {
    try {
      const s = await createSchedule(ctx.userId, {
        name: input.name,
        contact_id: input.contact_id ?? null,
        currency: input.currency,
        items: input.items,
        interval: input.interval ?? "monthly",
        interval_count: input.interval_count ?? 1,
        day_of_month: input.day_of_month ?? null,
        next_run_at: input.first_run_at ?? new Date().toISOString(),
        auto_send: input.auto_send ?? false,
        terms_days: input.terms_days ?? null,
      });
      return { ok: true, data: s, summary: `Created schedule "${s.name}" (next run ${s.next_run_at})` };
    } catch (err) {
      return fail(`Create recurring failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- billing.issue_credit_note ---------- */
const IssueCreditNoteInput = z.object({
  invoice_id: z.string().max(100).optional(),
  contact_id: z.string().max(100).optional(),
  items: LineItemsSchema.min(1).optional(),
  reason: z.string().max(2000).optional(),
});
registerTool<z.infer<typeof IssueCreditNoteInput>>({
  name: "billing.issue_credit_note",
  module: "billing",
  description: "Issue a credit note against an invoice (full credit when items are omitted) or for a contact.",
  input: IssueCreditNoteInput,
  parameters: {
    type: "object",
    properties: {
      invoice_id: { type: "string", description: "Invoice to credit (its lines are copied when items are omitted)" },
      contact_id: { type: "string" },
      items: ITEMS_PARAM,
      reason: { type: "string" },
    },
  },
  scope: "write",
  requiresApproval: true,
  preview: (i) => `Issue a credit note${i.invoice_id ? ` against invoice ${i.invoice_id}` : ""}${i.items ? ` (${i.items.length} line item(s))` : " (full amount)"}`,
  async run(ctx, input) {
    try {
      if (!input.invoice_id && !input.items) return fail("Provide an invoice_id or line items");
      const cn = await createCreditNote(ctx.userId, { invoice_id: input.invoice_id ?? null, contact_id: input.contact_id ?? null, items: input.items, reason: input.reason ?? null, issue: true });
      return { ok: true, data: cn, summary: `Issued credit note ${cn.number} for ${cn.total_minor} ${cn.currency} minor units` };
    } catch (err) {
      return fail(`Credit note failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- billing.statement ---------- */
const StatementInput = z.object({
  contact_id: z.string().min(1).max(100),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});
registerTool<z.infer<typeof StatementInput>>({
  name: "billing.statement",
  module: "billing",
  description: "Customer statement for a contact: opening balance, invoices, payments, credit notes and closing balance (default last 90 days).",
  input: StatementInput,
  parameters: {
    type: "object",
    properties: {
      contact_id: { type: "string" },
      from: { type: "string", description: "ISO date-time" },
      to: { type: "string", description: "ISO date-time" },
    },
    required: ["contact_id"],
  },
  scope: "read",
  preview: (i) => `Statement for contact ${i.contact_id}`,
  async run(ctx, input) {
    try {
      const st = await buildStatement(ctx.userId, input.contact_id, { from: input.from ? new Date(input.from) : null, to: input.to ? new Date(input.to) : null });
      if (!st) return fail("Contact not found");
      const bal = st.balances.map((b) => `${b.closing_minor} ${b.currency}`).join(", ") || "0";
      return { ok: true, data: st, summary: `Statement for ${st.contact.name}: ${st.entries.length} entries, closing balance ${bal} (minor units)` };
    } catch (err) {
      return fail(`Statement failed: ${errMsg(err)}`);
    }
  },
});
