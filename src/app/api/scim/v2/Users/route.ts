import type { NextRequest } from "next/server";
import { readScimJson, scimErrorResponse, scimJson, withScim } from "@/lib/scim/route";
import { listResponse, parseFilter, parsePaging } from "@/lib/scim/schema";
import { createScimUser, listScimUsers } from "@/lib/scim/users";

export const dynamic = "force-dynamic";

/** GET /api/scim/v2/Users?filter=userName eq "x"&startIndex=1&count=50 */
export async function GET(req: NextRequest) {
  return withScim(req, async (ctx, baseUrl) => {
    const sp = req.nextUrl.searchParams;
    const rawFilter = sp.get("filter");
    const filter = parseFilter(rawFilter);
    if (rawFilter && !filter) return scimErrorResponse(400, `Unsupported filter: ${rawFilter}`, "invalidFilter");
    const { startIndex, count } = parsePaging({ startIndex: sp.get("startIndex"), count: sp.get("count") });
    const { users, total } = await listScimUsers(ctx, { filter, startIndex, count, baseUrl });
    return scimJson(listResponse(users, total, startIndex));
  });
}

/** POST /api/scim/v2/Users — provision: invited membership + invite email via the outbox. */
export async function POST(req: NextRequest) {
  return withScim(req, async (ctx, baseUrl) => {
    const body = await readScimJson(req);
    if (!body.ok) return body.res;
    const user = await createScimUser(ctx, body.body, baseUrl);
    return scimJson(user, 201, { Location: user.meta.location ?? "" });
  });
}
