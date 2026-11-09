import { NextRequest } from "next/server";
import { loadPublicConfig } from "@/lib/webchat/public-config";
import { clientIp, enforceLimits, isUuid, jsonWith, widgetCors, widgetPreflight } from "@/lib/webchat/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ siteId: string }> };

export async function OPTIONS(req: NextRequest, { params }: Ctx) {
  return widgetPreflight(req, (await params).siteId);
}

/** GET /api/widget/config/[siteId] — public merged widget config (branding, modes, consent text, booking types). */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { siteId } = await params;
  const cors = await widgetCors(req, siteId);
  try {
    if (!isUuid(siteId)) return jsonWith(cors, { error: "not_found" }, 404);
    const limited = await enforceLimits(cors, [{ key: `widget:config:${clientIp(req)}`, limit: 120, windowMs: 60_000 }]);
    if (limited) return limited;
    const loaded = await loadPublicConfig(siteId);
    if (!loaded) return jsonWith(cors, { error: "not_found" }, 404);
    return jsonWith(cors, loaded.config, 200, { "Cache-Control": "public, max-age=60, s-maxage=60" });
  } catch (err) {
    console.error("[widget] config failed:", err);
    return jsonWith(cors, { error: "internal" }, 500);
  }
}
