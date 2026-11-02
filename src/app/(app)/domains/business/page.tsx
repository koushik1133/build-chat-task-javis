import { legacyHubRedirect } from "@/lib/records/legacy-redirect";

/** Legacy "business" hub: replaced by the records primitive ("startup" pack). */
export const dynamic = "force-dynamic";

export default async function DomainRedirectPage() {
  await legacyHubRedirect("startup", "/domains/business");
}
