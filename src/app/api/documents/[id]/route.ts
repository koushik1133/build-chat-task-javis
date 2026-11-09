import { NextResponse, type NextRequest } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { errorResponse, paramId, parseBody } from "@/lib/money/http";
import { deleteDocument, getDocument, updateDocument } from "@/lib/documents/documents";
import { DocumentPatchSchema } from "@/lib/documents/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  let scope;
  try {
    scope = await requireScope({ area: "crm" });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const document = await getDocument(scope.dataId, await paramId(ctx));
    if (!document) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ document });
  } catch (err) {
    return errorResponse(err, "documents.id.GET");
  }
}

/** PATCH — drafts only (title, body, merge data, signers, order, expiry). */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  let scope;
  try {
    scope = await requireScope({ area: "crm", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await parseBody(req, DocumentPatchSchema, 300_000);
  if (!body.ok) return body.res;
  try {
    const document = await updateDocument(scope.dataId, await paramId(ctx), body.data, scope.userId);
    return NextResponse.json({ document });
  } catch (err) {
    return errorResponse(err, "documents.id.PATCH");
  }
}

/** DELETE — drafts and voided documents only. */
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  let scope;
  try {
    scope = await requireScope({ area: "crm", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const ok = await deleteDocument(scope.dataId, await paramId(ctx), scope.userId);
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "documents.id.DELETE");
  }
}
