import { NextRequest } from "next/server";
import { searchArticles } from "@/lib/kb/search";
import { listPublicArticles } from "@/lib/kb/articles";
import { loadSiteForWidget, orgSlugFor } from "@/lib/webchat/public-config";
import { clientIp, enforceLimits, isUuid, jsonWith, widgetCors, widgetPreflight } from "@/lib/webchat/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ siteId: string }> };

export async function OPTIONS(req: NextRequest, { params }: Ctx) {
  return widgetPreflight(req, (await params).siteId);
}

/** GET ?q= — public help articles for the site's org (CORS-enabled). */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { siteId } = await params;
  const cors = await widgetCors(req, siteId);
  try {
    if (!isUuid(siteId)) return jsonWith(cors, { error: "not_found" }, 404);
    const limited = await enforceLimits(cors, [{ key: `widget:help:${clientIp(req)}`, limit: 120, windowMs: 60_000 }]);
    if (limited) return limited;
    const site = await loadSiteForWidget(siteId);
    if (!site) return jsonWith(cors, { error: "not_found" }, 404);
    const slug = await orgSlugFor(site.user_id);
    const q = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 200);
    const hits = q
      ? await searchArticles(site.user_id, q, 8, { publicOnly: true })
      : (await listPublicArticles(site.user_id)).articles.slice(0, 8);
    return jsonWith(cors, {
      q,
      articles: hits.map((a) => ({ id: a.id, slug: a.slug, title: a.title, excerpt: a.excerpt, url: slug ? `/help/${slug}/${a.slug}` : null })),
    }, 200, { "Cache-Control": "no-store" });
  } catch (err) {
    console.error("[widget] help failed:", err);
    return jsonWith(cors, { error: "internal" }, 500);
  }
}
