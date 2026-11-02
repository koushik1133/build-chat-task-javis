import { legacyHubRedirect } from "@/lib/records/legacy-redirect";

/** Legacy "finance" hub: replaced by the records primitive ("finance" pack). */
export const dynamic = "force-dynamic";

export default async function DomainRedirectPage() {
  await legacyHubRedirect("finance", "/domains/finance");
}
