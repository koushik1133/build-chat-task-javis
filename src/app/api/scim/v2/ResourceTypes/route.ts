import { withScim, scimJson } from "@/lib/scim/route";
import { listResponse, resourceTypes } from "@/lib/scim/schema";

export const dynamic = "force-dynamic";

/** GET /api/scim/v2/ResourceTypes */
export async function GET(req: Request) {
  return withScim(req, async (_ctx, baseUrl) => {
    const all = resourceTypes(baseUrl);
    return scimJson(listResponse(all, all.length, 1));
  });
}
