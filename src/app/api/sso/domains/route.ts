import { randomUUID } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { dbUnavailableResponse } from "@/lib/api-db";
import { query, queryOne } from "@/lib/dsql";
import { parseBody } from "@/lib/money/http";
import { canClaimSsoDomain } from "@/lib/sso/domains";

export const dynamic = "force-dynamic";

const Domain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/, "expected a domain like company.com");
const Body = z.object({ domain: Domain, providerId: z.string().trim().max(100).optional() }).strict();

interface DomainRow { id: string; domain: string; provider_id: string | null; created_at: string }

/** GET /api/sso/domains — email domains mapped to this workspace's SAML provider. */
export async function GET() {
  let scope;
  try {
    scope = await requireScope({ area: "settings" });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const domains = await query<DomainRow>(`SELECT id, domain, provider_id, created_at FROM sso_domains WHERE user_id = $1 ORDER BY domain ASC`, [scope.dataId]);
    return NextResponse.json({ domains });
  } catch (err) {
    return dbUnavailableResponse(err, "sso/domains");
  }
}

/** POST /api/sso/domains {domain, providerId?} */
export async function POST(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "settings", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = await parseBody(req, Body, 2_048);
  if (!parsed.ok) return parsed.res;
  try {
    if (!(await canClaimSsoDomain(scope, parsed.data.domain))) {
      return NextResponse.json(
        { error: "forbidden", detail: "You can only claim a domain that you or an active member of this workspace signs in with." },
        { status: 403 }
      );
    }
    const taken = await queryOne<{ user_id: string }>(`SELECT user_id FROM sso_domains WHERE domain = $1`, [parsed.data.domain]);
    if (taken && taken.user_id !== scope.dataId) return NextResponse.json({ error: "conflict", detail: "That domain is already claimed by another workspace." }, { status: 409 });
    if (taken) {
      await query(`UPDATE sso_domains SET provider_id = $3 WHERE domain = $1 AND user_id = $2`, [parsed.data.domain, scope.dataId, parsed.data.providerId ?? null]);
    } else {
      await query(`INSERT INTO sso_domains (id, user_id, domain, provider_id) VALUES ($1, $2, $3, $4)`, [randomUUID(), scope.dataId, parsed.data.domain, parsed.data.providerId ?? null]);
    }
    const row = await queryOne<DomainRow>(`SELECT id, domain, provider_id, created_at FROM sso_domains WHERE domain = $1`, [parsed.data.domain]);
    return NextResponse.json({ domain: row }, { status: taken ? 200 : 201 });
  } catch (err) {
    return dbUnavailableResponse(err, "sso/domains");
  }
}

/** DELETE /api/sso/domains?id= */
export async function DELETE(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "settings", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const id = req.nextUrl.searchParams.get("id")?.trim();
  if (!id || id.length > 64) return NextResponse.json({ error: "bad_request", detail: "id is required" }, { status: 400 });
  try {
    const rows = await query<{ id: string }>(`DELETE FROM sso_domains WHERE id = $1 AND user_id = $2 RETURNING id`, [id, scope.dataId]);
    if (rows.length === 0) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true, id });
  } catch (err) {
    return dbUnavailableResponse(err, "sso/domains");
  }
}
