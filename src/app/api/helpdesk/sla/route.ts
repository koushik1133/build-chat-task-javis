import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { createPolicy, deletePolicy, getPolicy, listPolicies, updatePolicy } from "@/lib/helpdesk/tickets";
import { PolicyPatchSchema, PolicySchema, errorResponse, parseBody } from "@/lib/helpdesk/http";

export const runtime = "nodejs";

/** GET /api/helpdesk/sla — all policies for the org. */
export async function GET() {
  try {
    const scope = await requireScope({ area: "helpdesk" });
    return NextResponse.json({ policies: await listPolicies(scope.dataId) });
  } catch (err) {
    return errorResponse(err, "helpdesk.sla.GET");
  }
}

/** POST /api/helpdesk/sla */
export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "helpdesk", edit: true });
    const body = await parseBody(req, PolicySchema);
    if (!body.ok) return body.res;
    const policy = await createPolicy(scope.dataId, body.data);
    return NextResponse.json({ policy }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "helpdesk.sla.POST");
  }
}

/** PATCH /api/helpdesk/sla?id= */
export async function PATCH(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "helpdesk", edit: true });
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id_required" }, { status: 400 });
    const body = await parseBody(req, PolicyPatchSchema);
    if (!body.ok) return body.res;
    if (!(await getPolicy(scope.dataId, id))) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const policy = await updatePolicy(scope.dataId, id, body.data);
    return NextResponse.json({ policy });
  } catch (err) {
    return errorResponse(err, "helpdesk.sla.PATCH");
  }
}

/** DELETE /api/helpdesk/sla?id= */
export async function DELETE(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "helpdesk", edit: true });
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id_required" }, { status: 400 });
    if (!(await getPolicy(scope.dataId, id))) return NextResponse.json({ error: "not_found" }, { status: 404 });
    await deletePolicy(scope.dataId, id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err, "helpdesk.sla.DELETE");
  }
}
