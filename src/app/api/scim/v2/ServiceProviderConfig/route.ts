import { withScim, scimJson } from "@/lib/scim/route";
import { serviceProviderConfig } from "@/lib/scim/schema";

export const dynamic = "force-dynamic";

/** GET /api/scim/v2/ServiceProviderConfig */
export async function GET(req: Request) {
  return withScim(req, async (_ctx, baseUrl) => scimJson(serviceProviderConfig(baseUrl)));
}
