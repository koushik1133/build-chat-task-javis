import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { dbUnavailableResponse } from "@/lib/api-db";
import { rateLimitAsync } from "@/lib/request-limits";
import { verificationRecord, verifyStoredDomain } from "@/lib/sso/verify";

export const dynamic = "force-dynamic";

/** POST /api/sso/domains/{id}/verify — run the DNS TXT check and persist the result. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let scope;
  try {
    scope = await requireScope({ area: "settings", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  if (!id || id.length > 64) return NextResponse.json({ error: "bad_request", detail: "id is required" }, { status: 400 });
  if (!(await rateLimitAsync(`sso-verify:${scope.dataId}`, 30, 60 * 60 * 1000)).allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  try {
    const row = await verifyStoredDomain(id, scope.dataId);
    const record = row.verification_token ? verificationRecord(row.domain, row.verification_token) : null;
    return NextResponse.json({
      domain: { id: row.id, domain: row.domain, verified_at: row.verified_at, last_verify_error: row.last_verify_error, record },
      verified: Boolean(row.verified_at),
    });
  } catch (err) {
    if (err instanceof Error && /not found/i.test(err.message)) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return dbUnavailableResponse(err, "sso/domains/verify");
  }
}
