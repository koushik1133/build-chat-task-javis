import { NextRequest, NextResponse } from "next/server";
import { getHelpCenterOrg, getPublicArticle } from "@/lib/kb/articles";
import { publicRateLimit } from "@/lib/money/http";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ org: string; slug: string }> };

/** GET /api/help/[org]/[slug] — one public article; increments views. */
export async function GET(req: NextRequest, ctx: Ctx) {
  const limited = publicRateLimit(req, "help", 120);
  if (limited) return limited;
  try {
    const { org: orgSlug, slug } = await ctx.params;
    const org = await getHelpCenterOrg(orgSlug);
    if (!org) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const article = await getPublicArticle(org.dataId, slug);
    if (!article) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ org: { name: org.name, slug: org.slug }, article });
  } catch (err) {
    console.error("[help] article GET failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
