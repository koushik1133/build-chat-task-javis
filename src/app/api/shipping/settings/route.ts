import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/lib/auth/scope";
import { parseBody } from "@/lib/money/http";
import { shippingError } from "@/lib/shipping/http";
 import { returnWindowDays, setReturnWindowDays } from "@/lib/shipping/returns";
import { getStorefront, updateStorefront } from "@/lib/storefront/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const scope = await requireScope({ area: "billing", edit: false });
    const sf = await getStorefront(scope.dataId);
    return NextResponse.json({ return_window_days: await returnWindowDays(scope.dataId), shipping_tax_bp: sf.settings.shipping_tax_bp ?? 0, storefront_configured: sf.configured });
  } catch (err) {
    return shippingError(err, "shipping.settings.GET");
  }
}

const Body = z.object({ return_window_days: z.number().int().min(0).max(365).optional(), shipping_tax_bp: z.number().int().min(0).max(10000).optional() }).strict();

export async function PUT(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, Body);
    if (!body.ok) return body.res;
    if (body.data.shipping_tax_bp !== undefined) await updateStorefront(scope.dataId, { settings: { shipping_tax_bp: body.data.shipping_tax_bp } });
    if (body.data.return_window_days !== undefined) await setReturnWindowDays(scope.dataId, body.data.return_window_days);
    const sf = await getStorefront(scope.dataId);
    return NextResponse.json({ return_window_days: await returnWindowDays(scope.dataId), shipping_tax_bp: sf.settings.shipping_tax_bp ?? 0 });
  } catch (err) {
    return shippingError(err, "shipping.settings.PUT");
  }
}
