import { queryOne } from "@/lib/dsql";
import { AREAS } from "@/lib/auth/roles";
import { ROUTES } from "@/lib/public-api/registry";
import { op, mustFind } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.me, async ({ principal }) => {
  const [key, org] = await Promise.all([
    queryOne<{ id: string; name: string; key_prefix: string; scopes: string | null; created_at: string; last_used_at: string | null }>(
      `SELECT id, name, key_prefix, scopes, created_at, last_used_at FROM api_keys WHERE id = $1`,
      [principal.keyId]
    ),
    queryOne<{ id: string; name: string; slug: string }>(`SELECT id, name, slug FROM organizations WHERE owner_user_id = $1`, [principal.dataId]).catch(() => null),
  ]);
  const k = mustFind(key, "API key");
  return {
    data: {
      key: { id: k.id, name: k.name, prefix: k.key_prefix, scopes: principal.scopes, created_at: k.created_at, last_used_at: k.last_used_at },
      user: { id: principal.userId },
      org: org ?? null,
      rate_limit: { limit: principal.rate.limit, remaining: principal.rate.remaining, reset: Math.ceil(principal.rate.resetAt / 1000) },
      areas: AREAS,
    },
  };
});
