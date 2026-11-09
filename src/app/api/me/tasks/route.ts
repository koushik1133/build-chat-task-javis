import { NextResponse, type NextRequest } from "next/server";
import { projectError, projectScope } from "@/lib/projects/http";
import { tasksForMember } from "@/lib/projects/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/me/tasks?all=1 — tasks assigned to the caller across projects (open by default). */
export async function GET(req: NextRequest) {
  const s = await projectScope(req, false);
  if (!s.ok) return s.res;
  try {
    const tasks = await tasksForMember(s.scope.dataId, s.scope.userId, { includeDone: req.nextUrl.searchParams.get("all") === "1" });
    return NextResponse.json({ tasks, member_id: s.scope.userId });
  } catch (err) {
    return projectError(err, "me.tasks");
  }
}
