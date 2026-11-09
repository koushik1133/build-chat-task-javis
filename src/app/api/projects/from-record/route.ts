import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { recordAudit } from "@/lib/audit";
import { parseBody } from "@/lib/money/http";
import { convertRecordToProject } from "@/lib/projects/convert";
import { projectError, projectScope } from "@/lib/projects/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ recordId: z.string().trim().min(1).max(100) }).strict();

/** POST /api/projects/from-record {recordId} — "Convert to project" for the records "projects" pack. Idempotent. */
export async function POST(req: NextRequest) {
  const s = await projectScope(req, true);
  if (!s.ok) return s.res;
  const parsed = await parseBody(req, Body, 4_096);
  if (!parsed.ok) return parsed.res;
  try {
    const out = await convertRecordToProject(s.scope.dataId, parsed.data.recordId, s.scope.userId);
    if (!out.alreadyConverted) void recordAudit(s.scope, { action: "create", entity: "project", entityId: out.project.id, after: { from_record: parsed.data.recordId }, req }).catch(() => undefined);
    return NextResponse.json(out, { status: out.alreadyConverted ? 200 : 201 });
  } catch (err) {
    return projectError(err, "projects.from_record");
  }
}
