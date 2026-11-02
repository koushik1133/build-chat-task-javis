import { NextResponse } from "next/server";
import { z } from "zod";
import { scopeErrorResponse } from "@/lib/auth/scope";
import { RecordValidationError } from "./schema";
import { getType } from "./store";
import { LINK_KINDS, type RecordType } from "./types";

export { parseBody } from "@/lib/money/http";

/** Body schemas for the records routes. */

export const RecordBodySchema = z
  .object({
    title: z.string().min(1).max(300),
    stage: z.string().max(60).nullable().optional(),
    data: z.record(z.unknown()).optional(),
    summary: z.string().max(4000).nullable().optional(),
    currency: z.string().length(3).nullable().optional(),
    assigned_to: z.string().max(100).nullable().optional(),
  })
  .strict();

export const RecordPatchSchema = RecordBodySchema.partial().strict();

export const MoveBodySchema = z.object({ stage: z.string().min(1).max(60) }).strict();

export const CommentBodySchema = z.object({ body: z.string().min(1).max(8000) }).strict();

export const LinkBodySchema = z
  .object({ target_kind: z.enum(LINK_KINDS), target_id: z.string().min(1).max(200) })
  .strict();

export const InstallPackSchema = z.object({ slug: z.string().min(1).max(60) }).strict();

export const MigrateLegacySchema = z.object({ tables: z.array(z.string().max(60)).max(20).optional() }).strict();

/** Map errors: scope → 401/403; validation → 400; not found → 404; else 500. */
export function recordsErrorResponse(err: unknown, log: string): NextResponse {
  const scoped = scopeErrorResponse(err);
  if (scoped) return scoped;
  if (err instanceof RecordValidationError) {
    return NextResponse.json({ error: "validation_failed", detail: err.issues }, { status: 400 });
  }
  if (err instanceof z.ZodError) {
    return NextResponse.json({ error: "invalid_body", detail: err.flatten() }, { status: 400 });
  }
  const msg = err instanceof Error ? err.message : "error";
  if (/not found/i.test(msg)) return NextResponse.json({ error: "not_found", detail: msg }, { status: 404 });
  if (/already exists|reserved slug/i.test(msg)) return NextResponse.json({ error: "conflict", detail: msg }, { status: 409 });
  console.error(`[${log}]`, err);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}

/** Resolve the `[type]` segment (slug or id) or return a 404 response. */
export async function resolveType(
  dataId: string,
  typeParam: string
): Promise<{ ok: true; type: RecordType } | { ok: false; res: NextResponse }> {
  const type = await getType(dataId, typeParam);
  if (!type) return { ok: false, res: NextResponse.json({ error: "not_found", detail: "Record type not found" }, { status: 404 }) };
  return { ok: true, type };
}

export type TypeCtx = { params: Promise<{ type: string }> };
export type TypeIdCtx = { params: Promise<{ type: string; id: string }> };
export type IdCtx = { params: Promise<{ id: string }> };
