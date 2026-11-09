import { NextResponse, type NextRequest } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { errorResponse, parseBody } from "@/lib/money/http";
import { createDocument, listDocuments } from "@/lib/documents/documents";
import { DocumentCreateSchema, DocumentListQuerySchema } from "@/lib/documents/schemas";
import { decodeCursor, encodeCursor, normaliseCursor } from "@/lib/public-api/pagination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/documents?status=&contact_id=&q=&cursor=&limit= */
export async function GET(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "crm" });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const parsed = DocumentListQuerySchema.safeParse(Object.fromEntries([...url.searchParams].filter(([k]) => ["status", "contact_id", "q"].includes(k))));
  if (!parsed.success) return NextResponse.json({ error: "invalid_query", detail: parsed.error.flatten() }, { status: 400 });
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 50) || 50));
  const cursor = decodeCursor(url.searchParams.get("cursor"));
  try {
    const rows = await listDocuments(scope.dataId, { status: parsed.data.status ?? null, contactId: parsed.data.contact_id ?? null, q: parsed.data.q ?? null, cursor, limit: limit + 1 });
    const hasMore = rows.length > limit;
    const documents = hasMore ? rows.slice(0, limit) : rows;
    const last = documents[documents.length - 1];
    return NextResponse.json({ documents, next_cursor: hasMore && last ? encodeCursor(normaliseCursor({ created_at: last.created_at, id: last.id })) : null, canEdit: scope.can("crm", true) });
  } catch (err) {
    return errorResponse(err, "documents.GET");
  }
}

/** POST /api/documents — create a draft from a template (+merge data) or a free body. */
export async function POST(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "crm", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await parseBody(req, DocumentCreateSchema, 300_000);
  if (!body.ok) return body.res;
  try {
    const document = await createDocument(scope.dataId, body.data, scope.userId);
    return NextResponse.json({ document }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "documents.POST");
  }
}
