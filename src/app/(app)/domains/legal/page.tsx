import { legacyHubRedirect } from "@/lib/records/legacy-redirect";

/** Legacy "legal" hub: replaced by the records primitive ("legal" pack). */
export const dynamic = "force-dynamic";

export default async function DomainRedirectPage() {
  await legacyHubRedirect("legal", "/domains/legal");
}
