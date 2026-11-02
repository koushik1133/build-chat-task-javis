import { legacyHubRedirect } from "@/lib/records/legacy-redirect";

/** Legacy "ecommerce" hub: replaced by the records primitive ("ecommerce" pack). */
export const dynamic = "force-dynamic";

export default async function DomainRedirectPage() {
  await legacyHubRedirect("ecommerce", "/domains/ecommerce");
}
