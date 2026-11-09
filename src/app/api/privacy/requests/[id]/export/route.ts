import { NextRequest, NextResponse } from "next/server";
import { recordAudit } from "@/lib/audit";
import { buildSubjectExport, getRequest } from "@/lib/privacy/dsr";
import { privacyError, privacyScope } from "../../../_lib";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** GET → JSON download of everything held about the request's subject. */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const s = await privacyScope(false);
  if ("res" in s) return s.res;
  try {
    const { id } = await ctx.params;
    const request = await getRequest(s.scope.dataId, id);
    if (!request) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const bundle = await buildSubjectExport(s.scope.dataId, { kind: request.subject_kind, id: request.subject_id });
    await recordAudit({ dataId: s.scope.dataId, userId: s.scope.userId, email: s.scope.email }, { action: "privacy.subject.exported", entity: "dsr_request", entityId: id });
    return new NextResponse(JSON.stringify({ request_id: id, kind: request.kind, ...bundle }, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="subject-export-${id.slice(0, 8)}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return privacyError(err, "export");
  }
}
