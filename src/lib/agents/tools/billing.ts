import { z } from "zod";
import { registerTool } from "@/lib/agents/registry";
import type { ToolResult } from "@/lib/agents/types";
import { LineItemsSchema, CurrencySchema } from "@/lib/money/items";
import { createQuote, listQuotes, sendQuote } from "@/lib/money/quotes";
import { createInvoice, listInvoices } from "@/lib/money/invoices";

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
