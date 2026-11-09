import { installListing } from "@/lib/marketplace/install";
import { ROUTES } from "@/lib/public-api/registry";
import { op, libCall } from "@/lib/public-api/handler";
import { listingView } from "@/lib/public-api/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = op(ROUTES.installListing, async ({ principal, params }) => {
  const r = await libCall(() => installListing(principal.dataId, params.id));
  return { data: { listing: listingView(r.listing), entity_kind: r.entityKind, entity_id: r.entityId, created: r.created, note: r.note }, status: 201 };
});
