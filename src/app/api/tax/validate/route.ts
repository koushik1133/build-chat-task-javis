import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/lib/auth/scope";
import { errorResponse, parseBody } from "@/lib/money/http";
import { rateLimitAsync } from "@/lib/request-limits";
import { lookupVies, validateTaxId, validatePan } from "@/lib/tax-compliance/validators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ regime: z.enum(["india_gst", "eu_vat", "uk_vat", "us_sales", "generic", "pan"]), id: z.string().trim().min(1).max(40), lookup: z.boolean().optional() }).strict();

/** POST /api/tax/validate - structure/checksum validation (optional VIES lookup for EU VAT). */
export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing" });
    const rl = await rateLimitAsync(`tax-validate:${scope.dataId}`, 120, 60_000);
    if (!rl.allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    const body = await parseBody(req, Body, 2_000);
    if (!body.ok) return body.res;
    const { regime, id, lookup } = body.data;
    if (lookup && !(await rateLimitAsync(`tax-vies:${scope.dataId}`, 20, 60_000)).allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    const result = regime === "pan" ? validatePan(id) : validateTaxId(regime, id);
    const vies = lookup && regime === "eu_vat" && result.valid ? await lookupVies(id) : null;
    return NextResponse.json({ result, vies });
  } catch (err) {
    return errorResponse(err, "tax.validate.POST");
  }
}
