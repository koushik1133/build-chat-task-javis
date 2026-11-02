import type { NextRequest } from "next/server";
import { readScimJson, scimErrorResponse, scimJson, withScim } from "@/lib/scim/route";
import { applyGroupPatch, parsePatchOps } from "@/lib/scim/schema";
import { getScimGroup, patchScimGroup } from "@/lib/scim/users";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const idOf = async (ctx: Ctx) => decodeURIComponent((await ctx.params).id).slice(0, 100);

/** GET /api/scim/v2/Groups/:id */
export async function GET(req: NextRequest, c: Ctx) {
  return withScim(req, async (ctx, baseUrl) => {
    const group = await getScimGroup(ctx, await idOf(c), baseUrl);
    return group ? scimJson(group) : scimErrorResponse(404, "Group not found.");
  });
}

/** PATCH /api/scim/v2/Groups/:id — add/remove/replace members → role changes. */
export async function PATCH(req: NextRequest, c: Ctx) {
  return withScim(req, async (ctx, baseUrl) => {
    const body = await readScimJson(req);
    if (!body.ok) return body.res;
    const ops = parsePatchOps(body.body);
    if (!ops) return scimErrorResponse(400, "Operations must be a non-empty array of {op, path?, value?}.", "invalidSyntax");
    let change;
    try {
      change = applyGroupPatch(ops);
    } catch (err) {
      return scimErrorResponse(400, err instanceof Error ? err.message : "Invalid PATCH.", "invalidPath");
    }
    const group = await patchScimGroup(ctx, await idOf(c), change, baseUrl);
    return group ? scimJson(group) : scimErrorResponse(404, "Group not found.");
  });
}

/** PUT / DELETE are not supported: groups are the fixed role set. */
export async function PUT(req: NextRequest) {
  return withScim(req, async () => scimErrorResponse(403, "Groups map to the fixed role set; use PATCH to change members.", "mutability"));
}
export async function DELETE(req: NextRequest) {
  return withScim(req, async () => scimErrorResponse(403, "Groups map to the fixed role set and cannot be deleted.", "mutability"));
}
