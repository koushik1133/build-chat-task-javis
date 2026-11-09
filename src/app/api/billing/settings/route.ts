import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/lib/auth/scope";
import { getBillingSettings, updateBillingSettings } from "@/lib/money/settings";
import { CurrencySchema } from "@/lib/money/items";
import { errorResponse, parseBody } from "@/lib/money/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Prefix = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,8}$/, "1-8 letters or digits");

const Patch = z
  .object({
    tax_id_label: z.string().trim().max(40).nullable().optional(),
    tax_number: z.string().trim().max(64).nullable().optional(),
    prices_include_tax: z.boolean().optional(),
    tax_rounding: z.enum(["per_line", "per_total"]).optional(),
    default_terms_days: z.number().int().min(0).max(365).optional(),
    dunning_schedule: z.array(z.number().int().min(-60).max(365)).min(1).max(12).optional(),
    quote_prefix: Prefix.optional(),
    invoice_prefix: Prefix.optional(),
    credit_note_prefix: Prefix.optional(),
    reporting_currency: CurrencySchema.nullable().optional(),
  })
  .strict();

/** GET /api/billing/settings — tax id, numbering, payment terms, dunning schedule, reporting currency. */
export async function GET() {
  try {
    const scope = await requireScope({ area: "billing" });
    const settings = await getBillingSettings(scope.dataId);
    return NextResponse.json({ settings, canEdit: scope.can("billing", true) });
  } catch (err) {
    return errorResponse(err, "billing.settings.GET");
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, Patch, 8_000);
    if (!body.ok) return body.res;
    const settings = await updateBillingSettings(scope.dataId, body.data);
    return NextResponse.json({ settings });
  } catch (err) {
    return errorResponse(err, "billing.settings.PATCH");
  }
}
