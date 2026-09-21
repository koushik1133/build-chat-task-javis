import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { query, queryOne } from "@/lib/dsql";
import { publishPost, isPublishingConfigured } from "@/lib/social/upload-post";
import { emitEvent } from "@/lib/events/bus";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Guard rail so one run can't sit in the publish loop indefinitely. */
const MAX_PER_RUN = 25;

interface DuePost {
  id: string;
  platform: string;
  caption: string;
  image_url: string | null;
  notes: string | null;
}

/**
 * POST /api/social/publish
 *
 * Publishes every approved post that is due. Each post is attempted
 * independently: one platform rejection marks that post `failed` with the
 * reason and the rest of the queue still goes out.
 */
export async function POST() {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const due = await query<DuePost>(
    `SELECT id, platform, caption, image_url, notes
     FROM social_posts
     WHERE user_id = $1 AND status = 'scheduled' AND scheduled_at <= NOW()
     ORDER BY scheduled_at ASC
     LIMIT ${MAX_PER_RUN}`,
    [user.id]
  );

  if (due.length === 0) {
    return NextResponse.json({ published: 0, failed: 0, message: "No posts due for publishing." });
  }

  if (!isPublishingConfigured()) {
    return NextResponse.json(
      {
        error:
          "Publishing is not configured. Set UPLOAD_POST_API_KEY to publish to connected accounts.",
        due: due.length,
      },
      { status: 503 }
    );
  }

  // Each user publishes through their own upload-post profile.
  const integration = await queryOne<{ upload_post_profile: string | null }>(
    `SELECT upload_post_profile FROM user_integrations WHERE user_id = $1`,
    [user.id]
  ).catch(() => null);

  const profile = integration?.upload_post_profile?.trim();
  if (!profile) {
    return NextResponse.json(
      {
        error:
          "No publishing profile is connected. Add one in Settings → Integrations before publishing.",
        due: due.length,
      },
      { status: 409 }
    );
  }

  const published: string[] = [];
  const failed: { id: string; error: string }[] = [];

  for (const post of due) {
    const result = await publishPost({
      profile,
      platforms: [post.platform],
      caption: post.caption,
      imageUrl: post.image_url,
    });

    if (result.ok) {
      await query(
        `UPDATE social_posts
         SET status = 'published', published_at = NOW(), platform_post_id = $2,
             publish_error = NULL, updated_at = NOW()
         WHERE id = $1 AND user_id = $3`,
        [post.id, result.postId ?? null, user.id]
      );
      published.push(post.id);
      void emitEvent(user.id, { type: "social.post.published", entity: "social_post", entityId: post.id, data: { platform: post.platform, platformPostId: result.postId ?? null } });
    } else {
      const message = result.error ?? "Unknown publishing error";
      await query(
        `UPDATE social_posts
         SET status = 'failed', publish_error = $2, updated_at = NOW()
         WHERE id = $1 AND user_id = $3`,
        [post.id, message.slice(0, 500), user.id]
      );
      failed.push({ id: post.id, error: message });
      void emitEvent(user.id, { type: "social.post.failed", entity: "social_post", entityId: post.id, data: { platform: post.platform, error: message.slice(0, 500) } });
    }
  }

  return NextResponse.json({
    published: published.length,
    failed: failed.length,
    posts: published,
    errors: failed,
    message:
      failed.length === 0
        ? `${published.length} post(s) published.`
        : `${published.length} published, ${failed.length} failed.`,
  });
}

/** GET /api/social/publish — posts currently due. */
export async function GET() {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const pending = await query(
    `SELECT * FROM social_posts
     WHERE user_id = $1 AND status = 'scheduled' AND scheduled_at <= NOW()
     ORDER BY scheduled_at ASC`,
    [user.id]
  );

  return NextResponse.json({ pending, configured: isPublishingConfigured() });
}
