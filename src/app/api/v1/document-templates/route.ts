import { listTemplates } from "@/lib/documents/templates";
import { ROUTES } from "@/lib/public-api/registry";
import { op } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listDocumentTemplates, async ({ principal }) => ({ data: await listTemplates(principal.dataId), meta: { next_cursor: null } }));
