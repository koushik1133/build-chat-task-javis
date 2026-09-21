import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { query } from "@/lib/dsql";

type PostRow = {
  id: string;
  platform: string;
  status: string;
  published_at: string | null;
};

/**
 * GET /api/social/analytics
 * Returns simulated engagement analytics per post and per platform.
 */
export async function GET() {
  let scope;
  try { scope = await requireScope({ area: "social", edit: false }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const userId = scope.dataId;

  const posts = await query<PostRow>(
    "SELECT id, platform, status, published_at FROM social_posts WHERE user_id = $1 ORDER BY created_at ASC",
    [userId]
  );

  // Simulate metrics for published posts
  const postMetrics = posts.map((p) => {
    const seed = p.id.charCodeAt(0) + p.id.charCodeAt(1);
    const impressions   = p.status === "published" ? 800 + (seed * 47) % 9200 : 0;
    const engagements   = Math.floor(impressions * (0.03 + (seed % 10) * 0.005));
    const clicks        = Math.floor(engagements * 0.4);
    const shares        = Math.floor(engagements * 0.15);
    const rate          = impressions > 0 ? ((engagements / impressions) * 100).toFixed(1) : "0.0";
    return {
      id: p.id,
      platform: p.platform,
      status: p.status,
      published_at: p.published_at,
      impressions,
      engagements,
      clicks,
      shares,
      engagement_rate: parseFloat(rate),
    };
  });

  // Aggregate by platform
  const byPlatform: Record<string, { platform: string; posts: number; impressions: number; engagements: number }> = {};
  for (const m of postMetrics) {
    if (!byPlatform[m.platform]) {
      byPlatform[m.platform] = { platform: m.platform, posts: 0, impressions: 0, engagements: 0 };
    }
    byPlatform[m.platform].posts++;
    byPlatform[m.platform].impressions += m.impressions;
    byPlatform[m.platform].engagements += m.engagements;
  }

  // Summary stats
  const published   = postMetrics.filter(p => p.status === "published").length;
  const totalImpressions = postMetrics.reduce((s, p) => s + p.impressions, 0);
  const totalEngagements = postMetrics.reduce((s, p) => s + p.engagements, 0);
  const avgRate = totalImpressions > 0
    ? ((totalEngagements / totalImpressions) * 100).toFixed(1)
    : "0.0";

  return NextResponse.json({
    summary: {
      total_posts: posts.length,
      published,
      total_impressions: totalImpressions,
      total_engagements: totalEngagements,
      avg_engagement_rate: parseFloat(avgRate),
    },
    by_platform: Object.values(byPlatform),
    posts: postMetrics,
  });
}
