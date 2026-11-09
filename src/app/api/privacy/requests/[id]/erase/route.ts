import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eraseSubject, getRequest } from "@/lib/privacy/dsr";
import { privacyError, privacyScope } from "../../../_lib";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const Schema = z.object({ mode: z.enum(["anonymize", "delete"]) }).strict();

/** POST {mode} → erase the subject and complete the request. Owner/admin with settings edit only. */
export async function POST(req: NextRequest, ctx: Ctx) {
  const s = await privacyScope(true);
  if ("res" in s) return s.res;
  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "mode must be anonymize or delete" }, { status: 400 });
  try {
    const { id } = await ctx.params;
    const request = await getRequest(s.scope.dataId, id);
    if (!request) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (request.status === "completed" || request.status === "rejected") return NextResponse.json({ error: "Request is already closed" }, { status: 409 });
    if (!request.verified_at) return NextResponse.json({ error: "Verify the subject before erasing" }, { status: 409 });
    const result = await eraseSubject(s.scope.dataId, { kind: request.subject_kind, id: request.subject_id }, { mode: parsed.data.mode, actorId: s.scope.userId, requestId: id });
    return NextResponse.json({ result, request: await getRequest(s.scope.dataId, id) });
  } catch (err) {
    return privacyError(err, "erase");
  }
}
