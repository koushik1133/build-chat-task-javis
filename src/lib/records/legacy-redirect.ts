import { redirect } from "next/navigation";
import { requireScope, ScopeError } from "@/lib/auth/scope";
import { getPack, installPack } from "@/lib/records/packs";
import { listTypes } from "@/lib/records/store";

/**
 * Legacy one-screen vertical hubs (/domains/<slug>) are replaced by the
 * records primitive. Editors get the pack installed (idempotent) and land on
 * its first record type; viewers are only redirected to what already exists.
 */
export async function legacyHubRedirect(packSlug: string, loginNext = "/r"): Promise<never> {
  let scope;
  try {
    scope = await requireScope({ area: "crm", edit: false });
  } catch (err) {
    if (err instanceof ScopeError && err.code === "FORBIDDEN") redirect("/r");
    redirect(`/login?next=${encodeURIComponent(loginNext)}`);
  }

  const pack = getPack(packSlug);
  const fallback = pack?.recordTypes[0]?.slug ?? null;
  let target: string | null = null;

  try {
    if (scope.can("crm", true)) {
      const types = await installPack(scope.dataId, packSlug);
      target = types[0]?.slug ?? fallback;
    } else {
      const installed = await listTypes(scope.dataId);
      const match = installed.find((t) => t.pack_slug === packSlug) ?? null;
      target = match?.slug ?? null;
    }
  } catch (err) {
    console.error(`[domains/${packSlug}] redirect failed:`, err);
  }

  redirect(target ? `/r/${target}` : "/r");
}
