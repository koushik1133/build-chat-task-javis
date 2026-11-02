import { legacyHubRedirect } from "@/lib/records/legacy-redirect";

/** Legacy "education" hub: replaced by the records primitive ("education" pack). */
export const dynamic = "force-dynamic";

export default async function DomainRedirectPage() {
  await legacyHubRedirect("education", "/domains/education");
}
