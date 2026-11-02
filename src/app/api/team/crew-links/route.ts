import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { recordAudit } from "@/lib/audit";
import { query } from "@/lib/dsql";
import { parseBody } from "@/lib/money/http";
import { hashToken, issueShareToken } from "@/lib/share-tokens";

export const dynamic = "force-dynamic";

/**
 * Crew links: token-scoped mobile access (/m/<token>) for field staff who do
 * not have an account. The token is shown once; only its hash is stored.
 */

const CreateBody = z
  .object({
    label: z.string().trim().min(1).max(80),
    expiresDays: z.number().int().min(1).max(365).optional(),
  })
  .strict();

interface CrewLinkRow {
  id: string;
  label: string | null;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_viewed_at: string | null;
}

function serialise(r: CrewLinkRow) {
  const expired = Boolean(r.expires_at && new Date(r.expires_at).getTime() < Date.now());
  return {
    id: r.id,
    label: r.label ?? "Crew link",
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    lastViewedAt: r.last_viewed_at,
    status: r.revoked_at ? "revoked" : expired ? "expired" : "active",
  };
}

/** GET /api/team/crew-links — all crew links for the workspace (newest first). */
export async function GET() {
  let scope;
  try {
    scope = await requireScope({ area: "team", edit: false });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const rows = await query<CrewLinkRow>(
    `SELECT id, label, created_at, expires_at, revoked_at, last_viewed_at
       FROM share_tokens WHERE user_id = $1 AND kind = 'crew' ORDER BY created_at DESC LIMIT 100`,
    [scope.dataId]
  ).catch((err) => {
    console.error("[crew-links] list failed:", err);
    return [] as CrewLinkRow[];
  });
  return NextResponse.json({ links: rows.map(serialise) });
}

/** POST /api/team/crew-links {label, expiresDays} → {id, url, token (once)} */
export async function POST(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "team", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = await parseBody(req, CreateBody, 4_096);
  if (!parsed.ok) return parsed.res;
  const { label, expiresDays = 30 } = parsed.data;

  try {
    const issued = await issueShareToken(scope.dataId, "crew", scope.orgId, expiresDays);
    const row = await query<{ id: string }>(
      `UPDATE share_tokens SET label = $3 WHERE user_id = $1 AND kind = 'crew' AND token_hash = $2 RETURNING id`,
      [scope.dataId, hashToken(issued.token), label]
    );
    const id = row[0]?.id ?? null;
    void recordAudit(scope, { action: "create", entity: "crew_link", entityId: id, after: { label, expiresDays }, req }).catch(() => undefined);
    return NextResponse.json({ id, label, url: issued.url, path: issued.path, expiresAt: issued.expiresAt }, { status: 201 });
  } catch (err) {
    console.error("[crew-links] create failed:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

/** DELETE /api/team/crew-links?id= — revoke a link. Idempotent. */
export async function DELETE(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "team", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const id = req.nextUrl.searchParams.get("id")?.trim();
  if (!id || id.length > 64) return NextResponse.json({ error: "bad_request", detail: "id is required" }, { status: 400 });
  const rows = await query<{ id: string }>(
    `UPDATE share_tokens SET revoked_at = NOW() WHERE id = $1 AND user_id = $2 AND kind = 'crew' AND revoked_at IS NULL RETURNING id`,
    [id, scope.dataId]
  ).catch((err) => {
    console.error("[crew-links] revoke failed:", err);
    return [] as Array<{ id: string }>;
  });
  if (rows.length) void recordAudit(scope, { action: "revoke", entity: "crew_link", entityId: id, req }).catch(() => undefined);
  return NextResponse.json({ ok: true, revoked: rows.length });
}
