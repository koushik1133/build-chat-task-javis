import { NextResponse, type NextRequest } from "next/server";
import { parseBody } from "@/lib/money/http";
import { paramId, projectError, projectScope } from "@/lib/projects/http";
import { ProjectTaskInputSchema } from "@/lib/projects/pure";
import { createProjectTask, listProjectTasks, requireProject } from "@/lib/projects/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/projects/[id]/tasks?done=&milestone=&assignee= */
export async function GET(req: NextRequest, ctx: Ctx) {
  const s = await projectScope(req, false);
  if (!s.ok) return s.res;
  try {
    const id = await paramId(ctx);
    await requireProject(s.scope.dataId, id);
    const sp = req.nextUrl.searchParams;
    const doneRaw = sp.get("done");
    const tasks = await listProjectTasks(s.scope.dataId, id, {
      done: doneRaw === "true" ? true : doneRaw === "false" ? false : null,
      milestoneId: sp.get("milestone"),
      assigneeId: sp.get("assignee"),
    });
    return NextResponse.json({ tasks });
  } catch (err) {
    return projectError(err, "projects.tasks.list");
  }
}

/** POST /api/projects/[id]/tasks — creates a task in the shared tasks table with project_id set. */
export async function POST(req: NextRequest, ctx: Ctx) {
  const s = await projectScope(req, true);
  if (!s.ok) return s.res;
  const parsed = await parseBody(req, ProjectTaskInputSchema, 16_384);
  if (!parsed.ok) return parsed.res;
  try {
    const task = await createProjectTask(s.scope.dataId, await paramId(ctx), parsed.data);
    return NextResponse.json({ task }, { status: 201 });
  } catch (err) {
    return projectError(err, "projects.tasks.create");
  }
}
