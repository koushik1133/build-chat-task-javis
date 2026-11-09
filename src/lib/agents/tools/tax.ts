import { z } from "zod";
import { registerTool } from "@/lib/agents/registry";
import type { ToolResult } from "@/lib/agents/types";
import { isPlanLimitError, assertFeature } from "@/lib/plans/enforce";
import { REGIMES, isRegime } from "@/lib/tax-compliance/regimes";
import { loadReport } from "@/lib/tax-compliance/reports-data";
import { getTaxProfile } from "@/lib/tax-compliance/store";
import { lookupVies, validatePan, validateTaxId } from "@/lib/tax-compliance/validators";

/** Tax tools (read-only): filing-ready report summary and tax-id validation. */

const fail = (error: string): ToolResult => ({ ok: false, summary: error, error });
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const ReportInput = z.object({
  regime: z.enum(REGIMES).optional(),
  from: z.string().regex(DATE),
  to: z.string().regex(DATE),
});
type ReportInputT = z.infer<typeof ReportInput>;

registerTool<ReportInputT>({
  name: "tax.report",
  module: "tax",
  description: "Summarise tax for a period (GSTR-1/3B style for India, VAT return boxes for EU/UK, sales-tax liability for US). Money is in minor units. A preparation aid, not tax advice.",
  input: ReportInput,
  parameters: {
    type: "object",
    properties: {
      regime: { type: "string", enum: [...REGIMES], description: "Defaults to the workspace tax profile regime" },
      from: { type: "string", description: "Period start YYYY-MM-DD" },
      to: { type: "string", description: "Period end YYYY-MM-DD" },
    },
    required: ["from", "to"],
  },
  scope: "read",
  preview: (i) => `Tax report ${i.from} to ${i.to}`,
  async run(ctx, input) {
    try {
      await assertFeature({ dataId: ctx.userId }, "tax_compliance");
      const profile = await getTaxProfile(ctx.userId);
      const regime = input.regime ?? profile?.regime ?? "generic";
      if (!isRegime(regime)) return fail("Unknown regime");
      const r = await loadReport(ctx.userId, regime, input.from, input.to, profile);
      return {
        ok: true,
        summary: `${r.title}: ${Object.entries(r.totals).slice(0, 4).map(([k, v]) => `${k}=${v}`).join(", ")} (${r.currency} minor units, ${r.warnings.length} warning(s))`,
        data: { regime: r.regime, currency: r.currency, totals: r.totals, warnings: r.warnings, report_hash: r.report_hash },
      };
    } catch (err) {
      if (isPlanLimitError(err)) return fail("Tax reports are not included in the current plan");
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

const ValidateInput = z.object({ regime: z.enum(["india_gst", "eu_vat", "uk_vat", "us_sales", "pan"]), id: z.string().trim().min(1).max(40), lookup: z.boolean().optional() });
type ValidateInputT = z.infer<typeof ValidateInput>;

registerTool<ValidateInputT>({
  name: "tax.validate_id",
  module: "tax",
  description: "Check the structure/checksum of a tax id (GSTIN, PAN, EU VAT ID, UK VAT number, US state code). Does not prove the id is registered unless the optional EU VIES lookup is enabled.",
  input: ValidateInput,
  parameters: {
    type: "object",
    properties: {
      regime: { type: "string", enum: ["india_gst", "eu_vat", "uk_vat", "us_sales", "pan"] },
      id: { type: "string" },
      lookup: { type: "boolean", description: "EU only: also run the VIES lookup (simulated unless enabled)" },
    },
    required: ["regime", "id"],
  },
  scope: "read",
  preview: (i) => `Validate ${i.regime} id`,
  async run(_ctx, input) {
    const result = input.regime === "pan" ? validatePan(input.id) : validateTaxId(input.regime, input.id);
    const vies = input.lookup && input.regime === "eu_vat" && result.valid ? await lookupVies(input.id) : null;
    return { ok: true, summary: result.valid ? "Valid format" : `Invalid: ${result.reason}`, data: { ...result, vies } };
  },
});
