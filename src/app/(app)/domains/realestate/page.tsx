import { legacyHubRedirect } from "@/lib/records/legacy-redirect";

/** Legacy "realestate" hub: replaced by the records primitive ("realestate" pack). */
export const dynamic = "force-dynamic";

export default async function DomainRedirectPage() {
  await legacyHubRedirect("realestate", "/domains/realestate");
}
