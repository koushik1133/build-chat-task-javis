import { query, queryOne } from "@/lib/dsql";
import type { PlaybookDef } from "./types";

type Brand = { id: string; name: string; industry: string | null; tone: string | null; target_audience: string | null; posting_frequency: string | null };

/**
 * A social_brands row with no social_posts scheduled in the next 3 days.
 * Entity id = brand id. Columns: social_posts.scheduled_at, status, brand_id.
 */
export const socialGap: PlaybookDef = {
  id: "social-gap",
  name: "Social calendar gap",
  description: "Warns when a brand has nothing scheduled for the next 3 days and drafts posts to fill the gap.",
  eventTypes: ["social.post.published", "social.post.failed"],
  cooldownHours: 48,
  defaultTools: ["social.draft_post", "social.schedule_post"],
  async detect(userId) {
    const rows = await query<{ id: string }>(
      `SELECT b.id FROM social_brands b
       WHERE b.user_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM social_posts p
           WHERE p.user_id = b.user_id AND p.brand_id = b.id
             AND p.status IN ('scheduled','published')
             AND p.scheduled_at BETWEEN NOW() AND NOW() + INTERVAL '3 days'
         )
       ORDER BY b.created_at ASC LIMIT 10`,
      [userId]
    ).catch(() => []);
    return rows.map((r) => r.id);
  },
  async buildPrompt(userId, entityId) {
    const b = await queryOne<Brand>(
      `SELECT id, name, industry, tone, target_audience, posting_frequency FROM social_brands WHERE id = $1 AND user_id = $2`,
      [entityId, userId]
    ).catch(() => null);
    if (!b) return `Brand ${entityId} no longer exists; do nothing and finish.`;
    return [
      `Brand "${b.name}" (id ${b.id}) has no social posts scheduled for the next 3 days.`,
      `Industry: ${b.industry ?? "unknown"}. Tone: ${b.tone ?? "professional"}. Audience: ${b.target_audience ?? "unknown"}. Target cadence: ${b.posting_frequency ?? "daily"}.`,
      "",
      "1. Draft 2-3 on-brand posts with social.draft_post, spread across the next 3 days.",
      "2. Schedule each with social.schedule_post (these pause for approval).",
    ].join("\n");
  },
};
