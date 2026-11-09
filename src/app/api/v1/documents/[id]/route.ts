import { getDocument } from "@/lib/documents/documents";
import { ROUTES } from "@/lib/public-api/registry";
import { op } from "@/lib/public-api/handler";
import { ApiError } from "@/lib/public-api/envelope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getDocument, async ({ principal, params }) => {
  const doc = await getDocument(principal.dataId, params.id);
  if (!doc) throw ApiError.notFound("Document not found");
  return { data: doc };
});
