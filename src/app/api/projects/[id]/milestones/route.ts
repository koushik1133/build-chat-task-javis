import { NextResponse, type NextRequest } from "next/server";
import { parseBody } from "@/lib/money/http";
import { paramId, projectError, projectScope } from "@/lib/projects/http";
import { MilestoneInputSchema } from "@/lib/projects/pure";
import { createMilestone, listMilestones, requireProject } from "@/lib/projects/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const s = await projectScope(req, false);
  if (!s.ok) return s.res;
  try {
    const id = await paramId(ctx);
    await requireProject(s.scope.dataId, id);
    return NextResponse.json({ milestones: await listMilestones(s.scope.dataId, id) });
  } catch (err) {
    return projectError(err, "projects.milestones.list");
  }
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const s = await projectScope(req, true);
  if (!s.ok) return s.res;
  const parsed = await parseBody(req, MilestoneInputSchema, 16_384);
  if (!parsed.ok) return parsed.res;
  try {
    const id = await paramId(ctx);
    const milestone = await createMilestone(s.scope.dataId, id, parsed.data);
    return NextResponse.json({ milestone }, { status: 201 });
  } catch (err) {
    return projectError(err, "projects.milestones.create");
  }
}
