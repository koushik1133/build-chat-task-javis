import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { dbUnavailableResponse } from "@/lib/api-db";
import { recordAudit } from "@/lib/audit";
import { paramId, parseBody } from "@/lib/money/http";
import { archiveChildOrg, getChildOrg, updateChildOrg } from "@/lib/agency/orgs";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const Patch = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    archived: z.boolean().optional(),
  })
  .strict();

/** GET /api/agency/workspaces/:id */
export async function GET(_req: NextRequest, ctx: Ctx) {
  let scope;
  try {
    scope = await requireScope({ area: "settings" });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const client = await getChildOrg(scope.dataId, await paramId(ctx));
    if (!client) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ client });
  } catch (err) {
    return dbUnavailableResponse(err, "agency/workspaces/id");
  }
}

/** PATCH /api/agency/workspaces/:id {name?, archived?} — rename or (un)archive. */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  let scope;
  try {
    scope = await requireScope({ area: "settings", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = await parseBody(req, Patch, 4_096);
  if (!parsed.ok) return parsed.res;
  try {
    const id = await paramId(ctx);
    const client = await updateChildOrg(scope.dataId, id, parsed.data);
    if (!client) return NextResponse.json({ error: "not_found" }, { status: 404 });
    void recordAudit(scope, { action: "update", entity: "client_workspace", entityId: id, after: parsed.data, req }).catch(() => undefined);
    return NextResponse.json({ client });
  } catch (err) {
    return dbUnavailableResponse(err, "agency/workspaces/id");
  }
}

/** DELETE /api/agency/workspaces/:id — archive (soft delete). Data is kept. */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  let scope;
  try {
    scope = await requireScope({ area: "settings", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const id = await paramId(ctx);
    const ok = await archiveChildOrg(scope.dataId, id);
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    void recordAudit(scope, { action: "archive", entity: "client_workspace", entityId: id, req }).catch(() => undefined);
    return NextResponse.json({ ok: true, id, archived: true });
  } catch (err) {
    return dbUnavailableResponse(err, "agency/workspaces/id");
  }
}
