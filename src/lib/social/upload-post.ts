/**
 * upload-post.com publishing connector.
 *
 * Multi-tenant model: the API key is a server-only credential shared by the
 * deployment, while each user maps to their own upload-post *profile*, so one
 * tenant can never publish to another tenant's connected social accounts.
 */

import { ALL_CHANNELS, toChannelId } from "@/lib/channels/registry";

const BASE_URL = "https://api.upload-post.com/api";

/**
 * Platforms upload-post can publish to — derived from the channel registry's
 * `capabilities.publishable`, so the transport and the UI cannot disagree
 * about whether a network is supported.
 */
export const PUBLISHABLE_PLATFORMS: string[] = ALL_CHANNELS
  .filter((c) => c.capabilities.publishable)
  .map((c) => c.id);

export type PublishablePlatform = string;

/** Accepts legacy spellings (twitter -> x) via the registry's alias map. */
export function isPublishablePlatform(v: string): boolean {
  const id = toChannelId(v);
  return id !== null && PUBLISHABLE_PLATFORMS.includes(id);
}

function apiKey(): string | undefined {
  return process.env.UPLOAD_POST_API_KEY?.trim() || undefined;
}

export function isPublishingConfigured(): boolean {
  return Boolean(apiKey());
}

export interface PublishResult {
  ok: boolean;
  /** Platform-side id when the provider returns one. */
  postId?: string;
  error?: string;
}

/** Providers vary in where they put the id; check the common shapes. */
function extractPostId(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const d = data as Record<string, unknown>;
  for (const key of ["post_id", "id", "postId"]) {
    const v = d[key];
    if (typeof v === "string" && v) return v;
  }
  const results = d.results;
  if (results && typeof results === "object") {
    for (const entry of Object.values(results as Record<string, unknown>)) {
      const id = extractPostId(entry);
      if (id) return id;
    }
  }
  return undefined;
}

interface PublishOptions {
  /** upload-post profile that owns the connected accounts (per user). */
  profile: string;
  platforms: string[];
  caption: string;
  title?: string;
  /** Public URL of the image to attach, when the post has one. */
  imageUrl?: string | null;
}

/**
 * Publish one post. Never throws — a failure is returned so the caller can
 * record it against the post and carry on with the rest of the queue.
 */
export async function publishPost(opts: PublishOptions): Promise<PublishResult> {
  const key = apiKey();
  if (!key) {
    return { ok: false, error: "Publishing is not configured (UPLOAD_POST_API_KEY is unset)." };
  }

  const platforms = opts.platforms
    .map((p) => toChannelId(p))
    .filter((p): p is string => p !== null && PUBLISHABLE_PLATFORMS.includes(p));
  if (platforms.length === 0) {
    return { ok: false, error: `No supported publishing target among: ${opts.platforms.join(", ") || "none"}.` };
  }

  const form = new FormData();
  form.append("user", opts.profile);
  for (const p of platforms) form.append("platform[]", p);
  form.append("title", opts.title?.slice(0, 200) || opts.caption.slice(0, 100));
  form.append("description", opts.caption);

  // Photo posts and text-only posts use different upload-post endpoints.
  const endpoint = opts.imageUrl ? `${BASE_URL}/upload_photos` : `${BASE_URL}/upload_text`;
  if (opts.imageUrl) form.append("photos[]", opts.imageUrl);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Apikey ${key}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });

    const json: unknown = await res.json().catch(() => null);

    if (!res.ok) {
      const message =
        (json && typeof json === "object" && typeof (json as { message?: unknown }).message === "string"
          ? (json as { message: string }).message
          : null) ?? `Publish failed with HTTP ${res.status}`;
      return { ok: false, error: message };
    }

    return { ok: true, postId: extractPostId(json) };
  } catch (err) {
    // A timeout or network fault — surfaced verbatim so the UI can explain it.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
