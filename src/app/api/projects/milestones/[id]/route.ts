import { NextResponse, type NextRequest } from "next/server";
import { parseBody } from "@/lib/money/http";
import { paramId, projectError, projectScope } from "@/lib/projects/http";
import { MilestonePatchSchema } from "@/lib/projects/pure";
import { deleteMilestone, updateMilestone } from "@/lib/projects/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** PATCH /api/projects/milestones/[id] — rename, re-date, reorder or complete (`status: "done"` emits milestone.completed). */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const s = await projectScope(req, true);
  if (!s.ok) return s.res;
  const parsed = await parseBody(req, MilestonePatchSchema, 16_384);
  if (!parsed.ok) return parsed.res;
  try {
    const milestone = await updateMilestone(s.scope.dataId, await paramId(ctx), parsed.data);
    return NextResponse.json({ milestone });
  } catch (err) {
    return projectError(err, "projects.milestones.patch");
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const s = await projectScope(req, true);
  if (!s.ok) return s.res;
  try {
    const id = await paramId(ctx);
    const ok = await deleteMilestone(s.scope.dataId, id);
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ id, deleted: true });
  } catch (err) {
    return projectError(err, "projects.milestones.delete");
  }
}
