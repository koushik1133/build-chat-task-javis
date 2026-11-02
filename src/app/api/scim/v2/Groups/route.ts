import type { NextRequest } from "next/server";
import { scimErrorResponse, scimJson, withScim } from "@/lib/scim/route";
import { listResponse, matchesFilter, parseFilter, parsePaging } from "@/lib/scim/schema";
import { listScimGroups } from "@/lib/scim/users";

export const dynamic = "force-dynamic";

/** GET /api/scim/v2/Groups — one group per role; members are the memberships with that role. */
export async function GET(req: NextRequest) {
  return withScim(req, async (ctx, baseUrl) => {
    const sp = req.nextUrl.searchParams;
    const rawFilter = sp.get("filter");
    const filter = parseFilter(rawFilter);
    if (rawFilter && !filter) return scimErrorResponse(400, `Unsupported filter: ${rawFilter}`, "invalidFilter");
    const { startIndex, count } = parsePaging({ startIndex: sp.get("startIndex"), count: sp.get("count") });
    let groups = await listScimGroups(ctx, baseUrl);
    if (filter) groups = groups.filter((g) => matchesFilter(g, filter));
    const page = groups.slice(startIndex - 1, startIndex - 1 + count);
    return scimJson(listResponse(page, groups.length, startIndex));
  });
}

/** POST /api/scim/v2/Groups — groups are the fixed role set and cannot be created. */
export async function POST(req: NextRequest) {
  return withScim(req, async () => scimErrorResponse(403, "Groups map to the fixed role set (owner, admin, manager, member, viewer) and cannot be created.", "mutability"));
}
