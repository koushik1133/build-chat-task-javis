import { NextResponse, type NextRequest } from "next/server";
import { parseBody } from "@/lib/money/http";
import { paramId, projectError, projectScope } from "@/lib/projects/http";
import { ProjectMemberInputSchema } from "@/lib/projects/pure";
import { addMember, listMembers, removeMember, requireProject } from "@/lib/projects/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const s = await projectScope(req, false);
  if (!s.ok) return s.res;
  try {
    const id = await paramId(ctx);
    await requireProject(s.scope.dataId, id);
    return NextResponse.json({ members: await listMembers(s.scope.dataId, id) });
  } catch (err) {
    return projectError(err, "projects.members.list");
  }
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const s = await projectScope(req, true);
  if (!s.ok) return s.res;
  const parsed = await parseBody(req, ProjectMemberInputSchema, 8_192);
  if (!parsed.ok) return parsed.res;
  try {
    const member = await addMember(s.scope.dataId, await paramId(ctx), parsed.data);
    return NextResponse.json({ member }, { status: 201 });
  } catch (err) {
    return projectError(err, "projects.members.add");
  }
}

/** DELETE /api/projects/[id]/members?id=<memberRowId> */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const s = await projectScope(req, true);
  if (!s.ok) return s.res;
  try {
    const projectId = await paramId(ctx);
    const id = String(req.nextUrl.searchParams.get("id") ?? "").slice(0, 100);
    if (!id) return NextResponse.json({ error: "bad_request", detail: "id is required" }, { status: 400 });
    const ok = await removeMember(s.scope.dataId, projectId, id);
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ id, deleted: true });
  } catch (err) {
    return projectError(err, "projects.members.remove");
  }
}
