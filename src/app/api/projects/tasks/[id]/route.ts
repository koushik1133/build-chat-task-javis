import { NextResponse, type NextRequest } from "next/server";
import { parseBody } from "@/lib/money/http";
import { paramId, projectError, projectScope } from "@/lib/projects/http";
import { ProjectTaskPatchSchema } from "@/lib/projects/pure";
import { updateProjectTask } from "@/lib/projects/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PATCH /api/projects/tasks/[id] — project-level task fields (done, milestone, assignee, due, priority, estimate, sort, depends_on). */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = await projectScope(req, true);
  if (!s.ok) return s.res;
  const parsed = await parseBody(req, ProjectTaskPatchSchema, 16_384);
  if (!parsed.ok) return parsed.res;
  try {
    const task = await updateProjectTask(s.scope.dataId, await paramId(ctx), parsed.data);
    return NextResponse.json({ task });
  } catch (err) {
    return projectError(err, "projects.tasks.patch");
  }
}
