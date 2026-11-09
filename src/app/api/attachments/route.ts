import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse, type Scope } from "@/lib/auth/scope";
import { rateLimitAsync } from "@/lib/request-limits";
import { errorResponse } from "@/lib/money/http";
import { AttachmentError, entityExists, isEntityKind, listAttachments, uploadAttachment } from "@/lib/attachments/store";
import { cappedRequest, isBodyTooLarge } from "@/lib/attachments/body-limit";
import { AREA_FOR_ENTITY, ATTACHMENT_ENTITY_KINDS, ATTACHMENT_VISIBILITIES, MAX_ATTACHMENT_BYTES, type AttachmentEntityKind } from "@/lib/attachments/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Query = z.object({ entity_kind: z.enum(ATTACHMENT_ENTITY_KINDS), entity_id: z.string().min(1).max(100) }).strict();
const Meta = z.object({ entity_kind: z.enum(ATTACHMENT_ENTITY_KINDS), entity_id: z.string().min(1).max(100), visibility: z.enum(ATTACHMENT_VISIBILITIES).optional() }).strict();

function forbidden(scope: Scope, kind: AttachmentEntityKind, edit: boolean): NextResponse | null {
  return scope.can(AREA_FOR_ENTITY[kind], edit) ? null : NextResponse.json({ error: "forbidden", detail: `Your role cannot ${edit ? "edit" : "view"} ${AREA_FOR_ENTITY[kind]}.` }, { status: 403 });
}

/** GET /api/attachments?entity_kind=&entity_id= */
export async function GET(req: NextRequest) {
  let scope: Scope;
  try {
    scope = await requireScope();
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: "invalid_query", detail: parsed.error.flatten() }, { status: 400 });
  const denied = forbidden(scope, parsed.data.entity_kind, false);
  if (denied) return denied;
  try {
    const attachments = await listAttachments(scope.dataId, parsed.data.entity_kind, parsed.data.entity_id);
    return NextResponse.json({ attachments });
  } catch (err) {
    return errorResponse(err, "attachments.GET");
  }
}

/** POST /api/attachments — multipart: file, entity_kind, entity_id, visibility? */
export async function POST(req: NextRequest) {
  let scope: Scope;
  try {
    scope = await requireScope();
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!(await rateLimitAsync(`attachments:upload:${scope.userId}`, 60, 60_000)).allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES + 64 * 1024) return NextResponse.json({ error: "payload_too_large", detail: "File must be 20 MB or smaller" }, { status: 413 });
  // Cap while streaming: the parse aborts as soon as the body passes the limit (+ multipart overhead) instead of buffering it all.
  let tooLarge = false;
  const form = await cappedRequest(req, MAX_ATTACHMENT_BYTES + 64 * 1024)
    .formData()
    .catch((err: unknown) => {
      tooLarge = isBodyTooLarge(err);
      return null;
    });
  if (tooLarge) return NextResponse.json({ error: "payload_too_large", detail: "File must be 20 MB or smaller" }, { status: 413 });
  if (!form) return NextResponse.json({ error: "invalid_body", detail: "multipart/form-data expected" }, { status: 400 });
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "invalid_body", detail: "file is required" }, { status: 400 });
  const meta = Meta.safeParse({ entity_kind: form.get("entity_kind"), entity_id: form.get("entity_id"), visibility: form.get("visibility") ?? undefined });
  if (!meta.success) return NextResponse.json({ error: "invalid_body", detail: meta.error.flatten() }, { status: 400 });
  if (!isEntityKind(meta.data.entity_kind)) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const denied = forbidden(scope, meta.data.entity_kind, true);
  if (denied) return denied;
  if (file.size > MAX_ATTACHMENT_BYTES) return NextResponse.json({ error: "payload_too_large", detail: "File must be 20 MB or smaller" }, { status: 413 });
  try {
    if (!(await entityExists(scope.dataId, meta.data.entity_kind, meta.data.entity_id))) return NextResponse.json({ error: "not_found", detail: "Entity not found" }, { status: 404 });
    const attachment = await uploadAttachment(scope.dataId, {
      entityKind: meta.data.entity_kind,
      entityId: meta.data.entity_id,
      fileName: file.name,
      declaredType: file.type || null,
      bytes: Buffer.from(await file.arrayBuffer()),
      visibility: meta.data.visibility ?? "internal",
      uploadedBy: scope.userId,
    });
    return NextResponse.json({ attachment }, { status: 201 });
  } catch (err) {
    if (err instanceof AttachmentError) return NextResponse.json({ error: "invalid_file", detail: err.message }, { status: err.status });
    return errorResponse(err, "attachments.POST");
  }
}
