import { NextResponse, type NextRequest } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { errorResponse, paramId, parseBody } from "@/lib/money/http";
import { deleteTemplate, DocumentError, getTemplate, updateTemplate } from "@/lib/documents/templates";
import { TemplatePatchSchema } from "@/lib/documents/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

function mapError(err: unknown, log: string) {
  if (err instanceof DocumentError) return NextResponse.json({ error: err.status === 404 ? "not_found" : "bad_request", detail: err.message }, { status: err.status });
  return errorResponse(err, log);
}

export async function GET(_req: NextRequest, ctx: Ctx) {
  let scope;
  try {
    scope = await requireScope({ area: "crm" });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const template = await getTemplate(scope.dataId, await paramId(ctx));
    if (!template) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ template });
  } catch (err) {
    return mapError(err, "document-templates.id.GET");
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  let scope;
  try {
    scope = await requireScope({ area: "crm", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await parseBody(req, TemplatePatchSchema, 300_000);
  if (!body.ok) return body.res;
  try {
    const template = await updateTemplate(scope.dataId, await paramId(ctx), body.data, scope.userId);
    return NextResponse.json({ template });
  } catch (err) {
    return mapError(err, "document-templates.id.PATCH");
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  let scope;
  try {
    scope = await requireScope({ area: "crm", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const ok = await deleteTemplate(scope.dataId, await paramId(ctx), scope.userId);
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return mapError(err, "document-templates.id.DELETE");
  }
}
