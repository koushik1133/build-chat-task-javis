import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { errorResponse, parseBody } from "@/lib/money/http";
import { recordAudit } from "@/lib/audit";
import { TaxProfileInputSchema, getTaxProfile, upsertTaxProfile } from "@/lib/tax-compliance/store";
import { REGIME_INFO, VERIFY_NOTICE } from "@/lib/tax-compliance/regimes";
import { validateTaxId } from "@/lib/tax-compliance/validators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const scope = await requireScope({ area: "billing" });
    const profile = await getTaxProfile(scope.dataId);
    return NextResponse.json({ profile, regimes: REGIME_INFO, notice: VERIFY_NOTICE });
  } catch (err) {
    return errorResponse(err, "tax.profile.GET");
  }
}

export async function PUT(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, TaxProfileInputSchema, 16_000);
    if (!body.ok) return body.res;
    const reg = body.data.registration_number;
    if (reg && body.data.regime !== "generic") {
      const v = validateTaxId(body.data.regime, reg);
      if (!v.valid && body.data.regime !== "us_sales") return NextResponse.json({ error: "invalid_registration_number", detail: v.reason }, { status: 400 });
    }
    const before = await getTaxProfile(scope.dataId);
    const profile = await upsertTaxProfile(scope.dataId, body.data);
    await recordAudit(scope, { action: "tax.profile.update", entity: "tax_profile", entityId: scope.dataId, before: before ? { regime: before.regime, registration_number: before.registration_number } : null, after: { regime: profile.regime, registration_number: profile.registration_number } });
    return NextResponse.json({ profile });
  } catch (err) {
    return errorResponse(err, "tax.profile.PUT");
  }
}
