import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { DSR_STATUSES } from "@/lib/privacy/constants";
import { listForSubject } from "@/lib/privacy/consent";
import { getRequest, updateRequest } from "@/lib/privacy/dsr";
import { privacyError, privacyScope } from "../../_lib";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const PatchSchema = z
  .object({
    status: z.enum(DSR_STATUSES).optional(),
    notes: z.string().trim().max(4000).nullable().optional(),
  })
  .strict();

export async function GET(_req: NextRequest, ctx: Ctx) {
  const s = await privacyScope(false);
  if ("res" in s) return s.res;
  try {
    const { id } = await ctx.params;
    const request = await getRequest(s.scope.dataId, id);
    if (!request) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const consents = await listForSubject(s.scope.dataId, { kind: request.subject_kind, id: request.subject_id }, 50);
    return NextResponse.json({ request, consents });
  } catch (err) {
    return privacyError(err, "get request");
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const s = await privacyScope(true);
  if ("res" in s) return s.res;
  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  try {
    const { id } = await ctx.params;
    const request = await updateRequest(s.scope.dataId, id, { status: parsed.data.status, notes: parsed.data.notes, handledBy: s.scope.userId }, s.scope.userId);
    return NextResponse.json({ request });
  } catch (err) {
    return privacyError(err, "update request");
  }
}
