import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { errorResponse, parseBody } from "@/lib/money/http";
import { recordAudit } from "@/lib/audit";
import { appOrigin } from "@/lib/share-tokens";
import { getStorefront, StorefrontPatchSchema, updateStorefront } from "@/lib/storefront/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/storefront — the org's storefront settings + public URL. */
export async function GET() {
  try {
    const scope = await requireScope({ area: "billing", edit: false });
    const storefront = await getStorefront(scope.dataId);
    return NextResponse.json({ storefront, public_url: `${appOrigin()}/shop/${storefront.slug}` });
  } catch (err) {
    return errorResponse(err, "storefront.GET");
  }
}

/** PATCH /api/storefront — partial update (enable, slug, title, intro, currency, shipping, pickup, terms, settings). */
export async function PATCH(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, StorefrontPatchSchema, 80_000);
    if (!body.ok) return body.res;
    const storefront = await updateStorefront(scope.dataId, body.data);
    void recordAudit({ dataId: scope.dataId, userId: scope.userId }, { action: "storefront.updated", entity: "storefront", entityId: scope.dataId, after: { keys: Object.keys(body.data) } });
    return NextResponse.json({ storefront, public_url: `${appOrigin()}/shop/${storefront.slug}` });
  } catch (err) {
    return errorResponse(err, "storefront.PATCH");
  }
}
