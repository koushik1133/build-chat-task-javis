import { legacyHubRedirect } from "@/lib/records/legacy-redirect";

/** Legacy "agency" hub: replaced by the records primitive ("agency" pack). */
export const dynamic = "force-dynamic";

export default async function DomainRedirectPage() {
  await legacyHubRedirect("agency", "/domains/agency");
}
