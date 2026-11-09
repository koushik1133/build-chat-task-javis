import { z } from "zod";
import { ListQuery } from "./schemas";

/** API v1 schemas for tax compliance (Phase 11). */

export const TaxReportQuery = z.object({
  regime: z.enum(["india_gst", "eu_vat", "uk_vat", "us_sales"]).optional().describe("Defaults to the workspace tax profile regime"),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Period start (YYYY-MM-DD)"),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Period end (YYYY-MM-DD)"),
});

export const TaxReport = z.object({
  regime: z.string(),
  kind: z.string(),
  title: z.string(),
  period: z.object({ from: z.string(), to: z.string() }),
  currency: z.string(),
  totals: z.record(z.string(), z.number()).describe("Minor units of the reporting currency"),
  sections: z.array(z.object({ key: z.string(), title: z.string(), columns: z.array(z.string()), rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))) })),
  warnings: z.array(z.string()),
  fx_notes: z.array(z.string()),
  report_hash: z.string(),
});

export const EInvoiceListQuery = ListQuery;
export const EInvoice = z.object({
  id: z.string(),
  invoice_id: z.string(),
  invoice_number: z.string().nullable(),
  format: z.enum(["ubl_peppol", "in_irp_json"]),
  status: z.enum(["draft", "generated", "submitted", "accepted", "rejected"]),
  payload_hash: z.string().nullable(),
  provider_ref: z.string().nullable(),
  error: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
