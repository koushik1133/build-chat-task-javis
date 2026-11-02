import { legacyHubRedirect } from "@/lib/records/legacy-redirect";

/** Legacy "healthcare" hub: replaced by the records primitive ("healthcare" pack). */
export const dynamic = "force-dynamic";

export default async function DomainRedirectPage() {
  await legacyHubRedirect("healthcare", "/domains/healthcare");
}
