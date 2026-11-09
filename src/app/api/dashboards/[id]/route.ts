import { NextResponse, type NextRequest } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { recordAudit } from "@/lib/audit";
import { DashboardPatchSchema, deleteDashboard, getDashboard, updateDashboard } from "@/lib/reports/store";
import { paramId, parseJson, reportsError } from "@/lib/reports/http";

export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  let scope;
  try {
    scope = await requireScope({ area: "reports" });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const dashboard = await getDashboard(scope.dataId, await paramId(ctx));
    return dashboard ? NextResponse.json({ dashboard }) : NextResponse.json({ error: "not_found" }, { status: 404 });
  } catch (err) {
    return reportsError(err, "dashboards.id.GET");
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  let scope;
  try {
    scope = await requireScope({ area: "reports", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await parseJson(req, DashboardPatchSchema);
  if (!body.ok) return body.res;
  try {
    const id = await paramId(ctx);
    const cur = await getDashboard(scope.dataId, id);
    if (!cur) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if ((cur.role || body.data.role || body.data.is_default) && !scope.can("team", true)) return NextResponse.json({ error: "forbidden", detail: "Only admins can edit role defaults." }, { status: 403 });
    const dashboard = await updateDashboard(scope.dataId, id, body.data);
    if (!dashboard) return NextResponse.json({ error: "not_found" }, { status: 404 });
    await recordAudit(scope, { action: "dashboard.updated", entity: "dashboard", entityId: id, after: { name: dashboard.name, widgets: dashboard.layout.length }, req });
    return NextResponse.json({ dashboard });
  } catch (err) {
    return reportsError(err, "dashboards.id.PATCH");
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  let scope;
  try {
    scope = await requireScope({ area: "reports", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const id = await paramId(ctx);
    const cur = await getDashboard(scope.dataId, id);
    if (!cur) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (cur.role && !scope.can("team", true)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    await deleteDashboard(scope.dataId, id);
    await recordAudit(scope, { action: "dashboard.deleted", entity: "dashboard", entityId: id, req });
    return NextResponse.json({ deleted: true });
  } catch (err) {
    return reportsError(err, "dashboards.id.DELETE");
  }
}
