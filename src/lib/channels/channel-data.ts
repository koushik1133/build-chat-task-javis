import { query } from "@/lib/dsql";
import { aliasesFor, getChannel, type ChannelDef } from "@/lib/channels/registry";

export interface ChannelAccount {
  id: string;
  handle: string;
  display_name: string | null;
  connected: boolean;
  has_token: boolean;
  created_at: string;
}

export interface ChannelPost {
  id: string;
  platform: string;
  content_type: string;
  caption: string;
  image_url: string | null;
  hashtags: string | null;
  scheduled_at: string | null;
  published_at: string | null;
  status: "draft" | "pending_approval" | "scheduled" | "published" | "failed";
  notes: string | null;
  publish_error: string | null;
}

export interface ChannelSnapshot {
  channel: ChannelDef;
  accounts: ChannelAccount[];
  posts: ChannelPost[];
  counts: {
    total: number;
    draft: number;
    scheduled: number;
    published: number;
    failed: number;
  };
}

/**
 * Everything the channel page needs, for ONE user.
 *
 * `userId` is the first parameter and there is no overload without it, so a
 * caller cannot read another tenant's channel by accident.
 */
export async function loadChannelSnapshot(
  userId: string,
  channelId: string
): Promise<ChannelSnapshot | null> {
  const channel = getChannel(channelId);
  if (!channel) return null;

  // Legacy spellings (twitter -> x) are matched here, in one place.
  const platforms = aliasesFor(channel.id);

  const accounts = await query<ChannelAccount>(
    `SELECT id, handle, display_name, connected,
            (access_token IS NOT NULL) AS has_token, created_at
     FROM social_accounts
     WHERE user_id = $1 AND platform = ANY($2)
     ORDER BY created_at ASC`,
    [userId, platforms]
  );

  const posts = await query<ChannelPost>(
    `SELECT id, platform, content_type, caption, image_url, hashtags,
            scheduled_at, published_at, status, notes, publish_error
     FROM social_posts
     WHERE user_id = $1 AND platform = ANY($2)
     ORDER BY COALESCE(published_at, scheduled_at, created_at) DESC
     LIMIT 60`,
    [userId, platforms]
  );

  const counts = {
    total: posts.length,
    draft: posts.filter((p) => p.status === "draft" || p.status === "pending_approval").length,
    scheduled: posts.filter((p) => p.status === "scheduled").length,
    published: posts.filter((p) => p.status === "published").length,
    failed: posts.filter((p) => p.status === "failed").length,
  };

  return { channel, accounts, posts, counts };
}
