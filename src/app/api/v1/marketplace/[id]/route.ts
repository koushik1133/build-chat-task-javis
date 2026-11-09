import { getListing } from "@/lib/marketplace/catalog";
import { ROUTES } from "@/lib/public-api/registry";
import { op, mustFind } from "@/lib/public-api/handler";
import { listingView } from "@/lib/public-api/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getListing, async ({ principal, params }) => {
  const l = mustFind(await getListing(principal.dataId, params.id), "Listing");
  return { data: { ...listingView(l), definition: l.definition } };
});
