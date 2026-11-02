import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { dbUnavailableResponse } from "@/lib/api-db";
import { recordAudit } from "@/lib/audit";
import { parseBody } from "@/lib/money/http";
import { createScimToken, listScimTokens, revokeScimToken, scimBaseUrl } from "@/lib/scim/auth";

export const dynamic = "force-dynamic";

const CreateBody = z.object({ name: z.string().trim().min(1).max(60) }).strict();

/** GET /api/scim/tokens — tokens for the active workspace + the SCIM base URL. */
export async function GET(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "settings" });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const tokens = await listScimTokens(scope.dataId);
    return NextResponse.json({
      tokens,
      baseUrl: scimBaseUrl(req),
      canEdit: scope.can("settings", true),
      sso: {
        enabled: process.env.SSO_ENABLED === "1",
        supabaseUrl: (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, ""),
      },
    });
  } catch (err) {
    return dbUnavailableResponse(err, "scim/tokens");
  }
}

/** POST /api/scim/tokens {name} → {token (once), record} */
export async function POST(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "settings", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = await parseBody(req, CreateBody, 2_048);
  if (!parsed.ok) return parsed.res;
  try {
    const { token, record } = await createScimToken(scope.dataId, parsed.data.name);
    void recordAudit(scope, { action: "create", entity: "scim_token", entityId: record.id, after: { name: record.name }, req }).catch(() => undefined);
    return NextResponse.json({ token, record }, { status: 201 });
  } catch (err) {
    return dbUnavailableResponse(err, "scim/tokens");
  }
}

/** DELETE /api/scim/tokens?id= — revoke. */
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
    const ok = await revokeScimToken(scope.dataId, id);
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    void recordAudit(scope, { action: "revoke", entity: "scim_token", entityId: id, req }).catch(() => undefined);
    return NextResponse.json({ ok: true, id });
  } catch (err) {
    return dbUnavailableResponse(err, "scim/tokens");
  }
}
