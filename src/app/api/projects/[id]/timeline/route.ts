import { NextResponse, type NextRequest } from "next/server";
import { paramId, projectError, projectScope } from "@/lib/projects/http";
import { timelineData } from "@/lib/projects/timeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/projects/[id]/timeline — Gantt-lite data (milestones + tasks). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = await projectScope(req, false);
  if (!s.ok) return s.res;
  try {
    return NextResponse.json({ timeline: await timelineData(s.scope.dataId, await paramId(ctx)) });
  } catch (err) {
    return projectError(err, "projects.timeline");
  }
}
