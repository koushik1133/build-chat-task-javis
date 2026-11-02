import { NextResponse, type NextRequest } from "next/server";
import { readScimJson, scimErrorResponse, scimJson, withScim } from "@/lib/scim/route";
import { parsePatchOps } from "@/lib/scim/schema";
import { deleteScimUser, getScimUser, patchScimUser, replaceScimUser } from "@/lib/scim/users";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const idOf = async (ctx: Ctx) => (await ctx.params).id.slice(0, 100);

/** GET /api/scim/v2/Users/:id */
export async function GET(req: NextRequest, c: Ctx) {
  return withScim(req, async (ctx, baseUrl) => {
    const user = await getScimUser(ctx, await idOf(c), baseUrl);
    return user ? scimJson(user) : scimErrorResponse(404, "User not found.");
  });
}

/** PUT /api/scim/v2/Users/:id — full replace (userName, active, roles). */
export async function PUT(req: NextRequest, c: Ctx) {
  return withScim(req, async (ctx, baseUrl) => {
    const body = await readScimJson(req);
    if (!body.ok) return body.res;
    const user = await replaceScimUser(ctx, await idOf(c), body.body, baseUrl);
    return user ? scimJson(user) : scimErrorResponse(404, "User not found.");
  });
}

/** PATCH /api/scim/v2/Users/:id — PatchOp; `active: false` deactivates (status removed). */
export async function PATCH(req: NextRequest, c: Ctx) {
  return withScim(req, async (ctx, baseUrl) => {
    const body = await readScimJson(req);
    if (!body.ok) return body.res;
    const ops = parsePatchOps(body.body);
    if (!ops) return scimErrorResponse(400, "Operations must be a non-empty array of {op, path?, value?}.", "invalidSyntax");
    const user = await patchScimUser(ctx, await idOf(c), ops, baseUrl);
    return user ? scimJson(user) : scimErrorResponse(404, "User not found.");
  });
}

/** DELETE /api/scim/v2/Users/:id → 204; the membership is soft-removed. */
export async function DELETE(req: NextRequest, c: Ctx) {
  return withScim(req, async (ctx) => {
    const ok = await deleteScimUser(ctx, await idOf(c));
    return ok ? new NextResponse(null, { status: 204 }) : scimErrorResponse(404, "User not found.");
  });
}
