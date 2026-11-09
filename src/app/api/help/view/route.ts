import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { query } from "@/lib/dsql";
import { getHelpCenterOrg } from "@/lib/kb/articles";
import { clientIp, rateLimitAsync } from "@/lib/request-limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/help/view { org, slug } — public, anonymous view counter for help
 * center articles (the article page itself is ISR-cached for 60 s, so it can
 * no longer count during render). Only published, public articles are
 * touched; unknown org/slug is a silent 204 so the endpoint cannot be used to
 * enumerate content.
 */
const Body = z
  .object({
    org: z.string().trim().min(1).max(80).regex(/^[a-z0-9-]+$/i),
    slug: z.string().trim().min(1).max(200).regex(/^[a-z0-9-]+$/i),
  })
  .strict();

export async function POST(req: NextRequest) {
  const limit = await rateLimitAsync(`help-view:${clientIp(req)}`, 120, 60_000);
  if (!limit.allowed) return new NextResponse(null, { status: 429 });
  const raw = await req.text().catch(() => "");
  if (raw.length > 1_024) return new NextResponse(null, { status: 413 });
  let json: unknown = null;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }
  const parsed = Body.safeParse(json);
  if (!parsed.success) return new NextResponse(null, { status: 400 });
  const org = await getHelpCenterOrg(parsed.data.org).catch(() => null);
  if (org) {
    await query(`UPDATE kb_articles SET views = views + 1 WHERE user_id = $1 AND slug = $2 AND status = 'published' AND is_public = TRUE`, [org.dataId, parsed.data.slug]).catch(() => undefined);
  }
  return new NextResponse(null, { status: 204 });
}
