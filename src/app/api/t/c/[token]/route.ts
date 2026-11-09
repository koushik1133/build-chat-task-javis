import { NextResponse, type NextRequest } from "next/server";
import { recordClick } from "@/lib/marketing/campaigns";
import { clickTargetAllowed, verifyToken } from "@/lib/marketing/tracking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Click redirect. The token signs sha256(url); `?u=` must match or we refuse
 * (400) — this can never become an open redirect for arbitrary targets.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const payload = verifyToken(token);
  if (!payload || payload.kind !== "click") return NextResponse.json({ error: "invalid_token" }, { status: 404 });
  const url = req.nextUrl.searchParams.get("u");
  if (!clickTargetAllowed(payload, url)) return NextResponse.json({ error: "url_not_allowed" }, { status: 400 });
  await recordClick(payload.recipientId, url).catch(() => undefined);
  return NextResponse.redirect(url, { status: 302, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}
