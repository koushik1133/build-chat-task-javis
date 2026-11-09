import { listCatalog } from "@/lib/marketplace/catalog";
import { ROUTES } from "@/lib/public-api/registry";
import { op, singlePage } from "@/lib/public-api/handler";
import { listingView } from "@/lib/public-api/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listListings, async ({ principal, query, list }) =>
  singlePage((await listCatalog(principal.dataId, { q: query.q ?? list.q, kind: query.kind ?? null, category: query.category ?? null, sort: query.sort ?? null, limit: list.limit })).map(listingView))
);
