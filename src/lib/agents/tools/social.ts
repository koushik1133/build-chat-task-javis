import { randomUUID } from "crypto";
import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { registerTool } from "@/lib/agents/registry";
import type { ToolResult } from "@/lib/agents/types";

/**
 * Social media tools. Publishing never calls the platform directly: it
 * schedules the post for NOW so the existing /api/social/publish loop sends it.
 */

const STATUSES = ["draft", "scheduled", "published", "failed"] as const;
const PLATFORMS = ["instagram", "facebook", "linkedin", "x", "twitter", "tiktok", "youtube", "threads", "pinterest"] as const;

const POST_COLS =
  "id, platform, content_type, caption, image_url, hashtags, scheduled_at, published_at, status, publish_error, created_at";

interface PostRow {
  id: string;
  platform: string;
  content_type: string;
  caption: string;
  image_url: string | null;
  hashtags: string | null;
  scheduled_at: string | null;
  published_at: string | null;
  status: string;
  publish_error: string | null;
  created_at: string;
}

function fail(error: string): ToolResult {
  return { ok: false, summary: error, error };
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
function parseWhen(s: string): Date | null {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* ---------- social.list_posts ---------- */
const ListInput = z.object({
  status: z.enum(STATUSES).optional(),
  platform: z.string().max(40).optional(),
});
type ListInputT = z.infer<typeof ListInput>;

registerTool<ListInputT>({
  name: "social.list_posts",
  module: "social",
  description: "List social posts (up to 25), optionally filtered by status (draft|scheduled|published|failed) and platform.",
  input: ListInput,
  parameters: {
    type: "object",
    properties: { status: { type: "string", enum: [...STATUSES] }, platform: { type: "string" } },
  },
  scope: "read",
  preview: (i) => `List ${i.status ?? "all"} posts${i.platform ? ` on ${i.platform}` : ""}`,
  async run(ctx, input) {
    try {
      const params: unknown[] = [ctx.userId];
      let sql = `SELECT ${POST_COLS} FROM social_posts WHERE user_id = $1`;
      if (input.status) {
        params.push(input.status);
        sql += ` AND status = $${params.length}`;
      }
      if (input.platform) {
        params.push(input.platform.toLowerCase());
        sql += ` AND LOWER(platform) = $${params.length}`;
      }
      sql += ` ORDER BY COALESCE(scheduled_at, created_at) DESC LIMIT 25`;
      const rows = await query<PostRow>(sql, params);
      return { ok: true, data: rows, summary: `Found ${rows.length} post(s)` };
    } catch (err) {
      return fail(`List failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- social.draft_post ---------- */
const DraftInput = z.object({
  platform: z.string().min(1).max(40),
  caption: z.string().min(1).max(5000),
  hashtags: z.string().max(1000).optional(),
  scheduled_at: z.string().max(40).optional(),
});
type DraftInputT = z.infer<typeof DraftInput>;

registerTool<DraftInputT>({
  name: "social.draft_post",
  module: "social",
  description: "Create a social post in draft status. Optionally attach a proposed scheduled_at (ISO datetime) without scheduling it.",
  input: DraftInput,
  parameters: {
    type: "object",
    properties: {
      platform: { type: "string", description: `One of ${PLATFORMS.join(", ")}` },
      caption: { type: "string" },
      hashtags: { type: "string", description: "Space-separated, e.g. '#launch #saas'" },
      scheduled_at: { type: "string", description: "ISO 8601 datetime (optional)" },
    },
    required: ["platform", "caption"],
  },
  scope: "write",
  requiresApproval: false,
  preview: (i) => `Draft ${i.platform} post: ${i.caption.slice(0, 80)}`,
  async run(ctx, input) {
    try {
      const when = input.scheduled_at ? parseWhen(input.scheduled_at) : null;
      if (input.scheduled_at && !when) return fail("scheduled_at is not a valid ISO datetime");
      const row = await queryOne<PostRow>(
        `INSERT INTO social_posts (id, user_id, platform, content_type, caption, hashtags, scheduled_at, status)
         VALUES ($1,$2,$3,'post',$4,$5,$6,'draft') RETURNING ${POST_COLS}`,
        [randomUUID(), ctx.userId, input.platform.toLowerCase(), input.caption, input.hashtags ?? null, when?.toISOString() ?? null]
      );
      if (!row) return fail("Insert returned no row");
      return { ok: true, data: row, summary: `Drafted ${row.platform} post ${row.id}` };
    } catch (err) {
      return fail(`Draft failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- social.schedule_post ---------- */
const ScheduleInput = z.object({ id: z.string().min(1), scheduled_at: z.string().min(1).max(40) });
type ScheduleInputT = z.infer<typeof ScheduleInput>;

registerTool<ScheduleInputT>({
  name: "social.schedule_post",
  module: "social",
  description: "Schedule an existing post for a given ISO datetime (status becomes 'scheduled').",
  input: ScheduleInput,
  parameters: {
    type: "object",
    properties: { id: { type: "string" }, scheduled_at: { type: "string", description: "ISO 8601 datetime" } },
    required: ["id", "scheduled_at"],
  },
  scope: "write",
  requiresApproval: false,
  preview: (i) => `Schedule post ${i.id} for ${i.scheduled_at}`,
  async run(ctx, input) {
    try {
      const when = parseWhen(input.scheduled_at);
      if (!when) return fail("scheduled_at is not a valid ISO datetime");
      const row = await queryOne<PostRow>(
        `UPDATE social_posts SET status = 'scheduled', scheduled_at = $1, publish_error = NULL, updated_at = NOW()
         WHERE id = $2 AND user_id = $3 AND status IN ('draft','scheduled','failed') RETURNING ${POST_COLS}`,
        [when.toISOString(), input.id, ctx.userId]
      );
      if (!row) return fail("Post not found or already published");
      return { ok: true, data: row, summary: `Scheduled ${row.platform} post for ${when.toISOString()}` };
    } catch (err) {
      return fail(`Schedule failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- social.publish_post ---------- */
const PublishInput = z.object({ id: z.string().min(1) });
type PublishInputT = z.infer<typeof PublishInput>;

registerTool<PublishInputT>({
  name: "social.publish_post",
  module: "social",
  description: "Publish a post now: marks it scheduled for immediate send so the publish queue posts it to the connected account. Requires approval.",
  input: PublishInput,
  parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  scope: "write",
  requiresApproval: true,
  preview: (i) => `Publish post ${i.id} to its platform now`,
  async run(ctx, input) {
    try {
      const row = await queryOne<PostRow>(
        `UPDATE social_posts SET status = 'scheduled', scheduled_at = NOW(), publish_error = NULL, updated_at = NOW()
         WHERE id = $1 AND user_id = $2 AND status <> 'published' RETURNING ${POST_COLS}`,
        [input.id, ctx.userId]
      );
      if (!row) return fail("Post not found or already published");
      return {
        ok: true,
        data: row,
        summary: `Post ${row.id} queued for immediate publishing on ${row.platform}`,
      };
    } catch (err) {
      return fail(`Publish failed: ${errMsg(err)}`);
    }
  },
});
