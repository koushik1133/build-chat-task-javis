import { NextResponse, type NextRequest } from "next/server";
import { recordAudit } from "@/lib/audit";
import { parseBody } from "@/lib/money/http";
import { projectBudget } from "@/lib/projects/budget";
import { paramId, projectError, projectScope } from "@/lib/projects/http";
import { projectProgress } from "@/lib/projects/progress";
import { ProjectPatchSchema } from "@/lib/projects/pure";
import { archiveProject, listMembers, listMilestones, requireProject, updateProject } from "@/lib/projects/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/projects/[id] — project with progress, budget, milestones and members. */
export async function GET(req: NextRequest, ctx: Ctx) {
  const s = await projectScope(req, false);
  if (!s.ok) return s.res;
  try {
    const id = await paramId(ctx);
    const project = await requireProject(s.scope.dataId, id);
    const [progress, budget, milestones, members] = await Promise.all([
      projectProgress(s.scope.dataId, id),
      projectBudget(s.scope.dataId, project),
      listMilestones(s.scope.dataId, id),
      listMembers(s.scope.dataId, id),
    ]);
    return NextResponse.json({ project, progress, budget, milestones, members });
  } catch (err) {
    return projectError(err, "projects.get");
  }
}

/** PATCH /api/projects/[id] */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const s = await projectScope(req, true);
  if (!s.ok) return s.res;
  const parsed = await parseBody(req, ProjectPatchSchema, 65_536);
  if (!parsed.ok) return parsed.res;
  try {
    const id = await paramId(ctx);
    const project = await updateProject(s.scope.dataId, id, parsed.data);
    void recordAudit(s.scope, { action: "update", entity: "project", entityId: id, after: parsed.data, req }).catch(() => undefined);
    return NextResponse.json({ project });
  } catch (err) {
    return projectError(err, "projects.patch");
  }
}

/** DELETE /api/projects/[id] — archive (history kept). */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const s = await projectScope(req, true);
  if (!s.ok) return s.res;
  try {
    const id = await paramId(ctx);
    const project = await archiveProject(s.scope.dataId, id);
    void recordAudit(s.scope, { action: "archive", entity: "project", entityId: id, req }).catch(() => undefined);
    return NextResponse.json({ project, archived: true });
  } catch (err) {
    return projectError(err, "projects.archive");
  }
}
