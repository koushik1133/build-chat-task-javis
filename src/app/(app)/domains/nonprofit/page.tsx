import { legacyHubRedirect } from "@/lib/records/legacy-redirect";

/** Legacy "nonprofit" hub: replaced by the records primitive ("nonprofit" pack). */
export const dynamic = "force-dynamic";

export default async function DomainRedirectPage() {
  await legacyHubRedirect("nonprofit", "/domains/nonprofit");
}
