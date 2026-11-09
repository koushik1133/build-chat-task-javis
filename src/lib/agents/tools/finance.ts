import { z } from "zod";
import { registerTool } from "@/lib/agents/registry";
import type { ToolResult } from "@/lib/agents/types";
import { CurrencySchema } from "@/lib/money/items";
import { listLowStock, listProducts, PRODUCT_KINDS } from "@/lib/inventory/products";
import { createExpense, EXPENSE_CATEGORIES } from "@/lib/finance/expenses";
import { createTimeEntry } from "@/lib/finance/time";
import { jobCosting, jobCostingSummary } from "@/lib/finance/job-costing";

/** Finance tools: pricebook/stock lookups, expense + time logging, job costing. Money is minor units. */

function fail(error: string): ToolResult {
  return { ok: false, summary: error, error };
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const REF_KIND = z.string().trim().min(1).max(40).regex(/^[a-z_]+$/);

/* ---------- products.search ---------- */
const SearchProductsInput = z.object({
  q: z.string().max(200).optional(),
  kind: z.enum(PRODUCT_KINDS).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
registerTool<z.infer<typeof SearchProductsInput>>({
  name: "products.search",
  module: "finance",
  description: "Search the pricebook (products, services, rentals) by name, SKU or description. Returns prices, cost and stock levels.",
  input: SearchProductsInput,
  parameters: {
    type: "object",
    properties: {
      q: { type: "string", description: "Free-text match on name, SKU or description" },
      kind: { type: "string", enum: [...PRODUCT_KINDS] },
      limit: { type: "integer" },
    },
  },
  scope: "read",
  preview: (i) => `Search products${i.q ? ` for "${i.q}"` : ""}`,
  async run(ctx, input) {
    try {
      const products = await listProducts(ctx.userId, { q: input.q, kind: input.kind, limit: input.limit ?? 25 });
      return { ok: true, data: products, summary: `Found ${products.length} product(s)` };
    } catch (err) {
      return fail(`Search failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- products.low_stock ---------- */
const LowStockInput = z.object({ limit: z.number().int().min(1).max(100).optional() });
registerTool<z.infer<typeof LowStockInput>>({
  name: "products.low_stock",
  module: "finance",
  description: "List tracked products whose available stock (on hand minus reserved) is at or below the reorder point.",
  input: LowStockInput,
  parameters: { type: "object", properties: { limit: { type: "integer" } } },
  scope: "read",
  preview: () => "List low-stock products",
  async run(ctx, input) {
    try {
      const products = await listLowStock(ctx.userId, input.limit ?? 50);
      return {
        ok: true,
        data: products.map((p) => ({ id: p.id, sku: p.sku, name: p.name, available: p.stock_available, on_hand: p.stock_on_hand, reserved: p.stock_reserved, reorder_point: p.reorder_point })),
        summary: products.length === 0 ? "No products are low on stock" : `${products.length} product(s) at or below reorder point`,
      };
    } catch (err) {
      return fail(`Low-stock check failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- expenses.log ---------- */
const LogExpenseInput = z.object({
  amount_minor: z.number().int().min(0).max(1_000_000_000_000),
  currency: CurrencySchema.optional(),
  category: z.string().trim().min(1).max(40).optional(),
  vendor: z.string().trim().max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  tax_minor: z.number().int().min(0).max(1_000_000_000_000).optional(),
  spent_at: z.string().datetime({ offset: true }).optional(),
  ref_kind: REF_KIND.optional(),
  ref_id: z.string().trim().max(100).optional(),
  billable: z.boolean().optional(),
});
registerTool<z.infer<typeof LogExpenseInput>>({
  name: "expenses.log",
  module: "finance",
  description: "Record a business expense (cash out), optionally against a job (e.g. ref_kind=invoice) and flagged billable to the client.",
  input: LogExpenseInput,
  parameters: {
    type: "object",
    properties: {
      amount_minor: { type: "integer", description: "Amount before tax in minor units (cents)" },
      currency: { type: "string", description: "ISO 4217, default USD" },
      category: { type: "string", description: `One of ${EXPENSE_CATEGORIES.join(", ")} (free text allowed)` },
      vendor: { type: "string" },
      description: { type: "string" },
      tax_minor: { type: "integer" },
      spent_at: { type: "string", description: "ISO datetime; defaults to now" },
      ref_kind: { type: "string", description: "Job type the cost belongs to: invoice, quote, booking, record" },
      ref_id: { type: "string" },
      billable: { type: "boolean", description: "Can be re-billed to the client" },
    },
    required: ["amount_minor"],
  },
  scope: "write",
  requiresApproval: true,
  preview: (i) => `Log expense of ${i.amount_minor} ${i.currency ?? "USD"} minor units${i.vendor ? ` at ${i.vendor}` : ""}`,
  async run(ctx, input) {
    try {
      const e = await createExpense(ctx.userId, {
        amount_minor: input.amount_minor,
        currency: input.currency ?? "USD",
        category: input.category ?? "general",
        vendor: input.vendor ?? null,
        description: input.description ?? null,
        tax_minor: input.tax_minor ?? 0,
        spent_at: input.spent_at,
        ref_kind: input.ref_kind ?? null,
        ref_id: input.ref_id ?? null,
        billable: input.billable ?? false,
      }, ctx.userId);
      return { ok: true, data: e, summary: `Logged expense ${e.id} (${e.total_minor} ${e.currency} minor units)` };
    } catch (err) {
      return fail(`Log expense failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- time.log ---------- */
const LogTimeInput = z.object({
  minutes: z.number().int().min(1).max(100_000),
  description: z.string().trim().max(2000).optional(),
  started_at: z.string().datetime({ offset: true }).optional(),
  rate_minor: z.number().int().min(0).max(1_000_000_000).optional(),
  currency: CurrencySchema.optional(),
  ref_kind: REF_KIND.optional(),
  ref_id: z.string().trim().max(100).optional(),
  billable: z.boolean().optional(),
});
registerTool<z.infer<typeof LogTimeInput>>({
  name: "time.log",
  module: "finance",
  description: "Log completed work time (minutes) against a job at an hourly rate.",
  input: LogTimeInput,
  parameters: {
    type: "object",
    properties: {
      minutes: { type: "integer" },
      description: { type: "string" },
      started_at: { type: "string", description: "ISO datetime the work started; defaults to now minus minutes" },
      rate_minor: { type: "integer", description: "Hourly rate in minor units" },
      currency: { type: "string" },
      ref_kind: { type: "string", description: "invoice | quote | booking | record" },
      ref_id: { type: "string" },
      billable: { type: "boolean" },
    },
    required: ["minutes"],
  },
  scope: "write",
  requiresApproval: true,
  preview: (i) => `Log ${i.minutes} minute(s)${i.description ? ` — ${i.description}` : ""}`,
  async run(ctx, input) {
    try {
      const started_at = input.started_at ?? new Date(Date.now() - input.minutes * 60_000).toISOString();
      const e = await createTimeEntry(ctx.userId, {
        minutes: input.minutes,
        started_at,
        description: input.description ?? null,
        rate_minor: input.rate_minor ?? 0,
        currency: input.currency ?? "USD",
        ref_kind: input.ref_kind ?? null,
        ref_id: input.ref_id ?? null,
        billable: input.billable ?? true,
        member_id: ctx.userId,
      }, ctx.userId);
      return { ok: true, data: e, summary: `Logged ${e.minutes} min (${e.value_minor} ${e.currency} minor units)` };
    } catch (err) {
      return fail(`Log time failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- reports.job_costing ---------- */
const JobCostingInput = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  ref_kind: REF_KIND.optional(),
  ref_id: z.string().trim().max(100).optional(),
});
registerTool<z.infer<typeof JobCostingInput>>({
  name: "reports.job_costing",
  module: "finance",
  description: "Job costing report: revenue from paid invoices vs costs (expenses, time at rate, consumed stock at cost) and margin, per job. Pass ref_kind+ref_id for one job or a date range for all.",
  input: JobCostingInput,
  parameters: {
    type: "object",
    properties: {
      from: { type: "string", description: "ISO datetime" },
      to: { type: "string", description: "ISO datetime" },
      ref_kind: { type: "string", description: "invoice | quote | booking | record" },
      ref_id: { type: "string" },
    },
  },
  scope: "read",
  preview: (i) => (i.ref_kind && i.ref_id ? `Job costing for ${i.ref_kind} ${i.ref_id}` : "Job costing summary"),
  async run(ctx, input) {
    try {
      const report = input.ref_kind && input.ref_id
        ? await jobCosting(ctx.userId, { refKind: input.ref_kind, refId: input.ref_id })
        : await jobCostingSummary(ctx.userId, { from: input.from, to: input.to });
      const t = report.totals;
      return {
        ok: true,
        data: report,
        summary: `${report.jobs.length} job(s): revenue ${t.revenue_minor}, cost ${t.cost_minor}, margin ${t.margin_minor} (${t.margin_pct ?? "n/a"}%) minor units`,
      };
    } catch (err) {
      return fail(`Job costing failed: ${errMsg(err)}`);
    }
  },
});

/* ═══ Phase 6: change orders ═══ */
import { createChangeOrder } from "@/lib/finance/change-orders";
import { LineItemsSchema } from "@/lib/money/items";

const ChangeOrderInput = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000).optional(),
  quote_id: z.string().max(100).optional(),
  invoice_id: z.string().max(100).optional(),
  items: LineItemsSchema.optional(),
  currency: CurrencySchema.optional(),
});
registerTool<z.infer<typeof ChangeOrderInput>>({
  name: "finance.create_change_order",
  module: "finance",
  description: "Create a draft change order (priced scope change) against a quote and/or invoice. Items use minor-unit prices. Accepting it later bills the items.",
  input: ChangeOrderInput,
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" },
      description: { type: "string" },
      quote_id: { type: "string" },
      invoice_id: { type: "string" },
      items: { type: "array", items: { type: "object", properties: { description: { type: "string" }, qty: { type: "number" }, unit_minor: { type: "integer" } }, required: ["description", "qty", "unit_minor"] } },
      currency: { type: "string" },
    },
    required: ["title"],
  },
  scope: "write",
  requiresApproval: false,
  preview: (i) => `Create change order "${i.title}"${i.quote_id ? ` on quote ${i.quote_id}` : i.invoice_id ? ` on invoice ${i.invoice_id}` : ""}`,
  async run(ctx, input) {
    try {
      const co = await createChangeOrder(ctx.userId, { title: input.title, description: input.description ?? null, quote_id: input.quote_id ?? null, invoice_id: input.invoice_id ?? null, items: input.items ?? [], currency: input.currency });
      return { ok: true, data: { id: co.id, label: co.label, title: co.title, delta_minor: co.delta_minor, currency: co.currency, status: co.status }, summary: `Created ${co.label} "${co.title}" (${co.delta_minor} ${co.currency}, draft)` };
    } catch (err) {
      return fail(`Change order failed: ${errMsg(err)}`);
    }
  },
});
