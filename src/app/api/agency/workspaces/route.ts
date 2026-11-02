import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { dbUnavailableResponse } from "@/lib/api-db";
import { recordAudit } from "@/lib/audit";
import { parseBody } from "@/lib/money/http";
import { createChildOrg, listChildOrgs, orgByDataId } from "@/lib/agency/orgs";

export const dynamic = "force-dynamic";

const CreateBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    slug: z.string().trim().min(2).max(40).regex(/^[a-z0-9-]+$/, "lowercase letters, numbers and dashes").optional(),
  })
  .strict();

/** GET /api/agency/workspaces?archived=1 — client workspaces owned by the active org. */
export async function GET(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "settings" });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const includeArchived = req.nextUrl.searchParams.get("archived") === "1";
    const [clients, org] = await Promise.all([listChildOrgs(scope.dataId, { includeArchived }), orgByDataId(scope.dataId)]);
    const kind = org?.kind === "client" ? "client" : org?.kind === "agency" ? "agency" : "standard";
    return NextResponse.json({ clients, org: { id: scope.orgId, name: scope.orgName, kind }, canEdit: scope.can("settings", true) });
  } catch (err) {
    return dbUnavailableResponse(err, "agency/workspaces");
  }
}

/** POST /api/agency/workspaces {name, slug?} — create a client workspace (owner/admin). */
export async function POST(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "settings", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = await parseBody(req, CreateBody, 4_096);
  if (!parsed.ok) return parsed.res;
  try {
    const self = await orgByDataId(scope.dataId);
    if (self?.kind === "client") {
      return NextResponse.json({ error: "forbidden", detail: "A client workspace cannot own other workspaces." }, { status: 403 });
    }
    const client = await createChildOrg(scope, parsed.data);
    void recordAudit(scope, { action: "create", entity: "client_workspace", entityId: client.id, after: { name: client.name, slug: client.slug }, req }).catch(() => undefined);
    return NextResponse.json({ client }, { status: 201 });
  } catch (err) {
    return dbUnavailableResponse(err, "agency/workspaces");
  }
}
