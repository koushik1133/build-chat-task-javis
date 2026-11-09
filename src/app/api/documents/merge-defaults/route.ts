import { NextResponse, type NextRequest } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { errorResponse } from "@/lib/money/http";
import { mergeDefaults } from "@/lib/documents/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/documents/merge-defaults?contact_id= — contact.* / org.* values to prefill the merge form. */
export async function GET(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "crm" });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const contactId = new URL(req.url).searchParams.get("contact_id")?.slice(0, 100) || null;
  try {
    return NextResponse.json({ defaults: await mergeDefaults(scope.dataId, contactId) });
  } catch (err) {
    return errorResponse(err, "documents.merge-defaults");
  }
}
