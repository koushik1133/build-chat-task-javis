import { NextResponse, type NextRequest } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { isRole } from "@/lib/auth/roles";
import { recordAudit } from "@/lib/audit";
import { DashboardInputSchema, createDashboard, defaultDashboardForRole, listDashboards, starterDashboard } from "@/lib/reports/store";
import { parseJson, reportsError } from "@/lib/reports/http";

export const runtime = "nodejs";

/**
 * GET /api/dashboards            → all dashboards for the org
 * GET /api/dashboards?default=1  → the default for the caller's role (`saved:false` when it is the starter layout)
 * GET /api/dashboards?role=admin → the default for a given role (admins editing per-role defaults)
 */
export async function GET(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "reports" });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const sp = req.nextUrl.searchParams;
    const roleParam = sp.get("role");
    if (sp.get("default") === "1" || roleParam) {
      const role = roleParam && isRole(roleParam) ? roleParam : scope.role;
      const saved = await defaultDashboardForRole(scope.dataId, role);
      return NextResponse.json({ dashboard: saved ?? starterDashboard(role), saved: Boolean(saved), role });
    }
    return NextResponse.json({ dashboards: await listDashboards(scope.dataId) });
  } catch (err) {
    return reportsError(err, "dashboards.GET");
  }
}

/** POST /api/dashboards — admins only when `role`/`is_default` is set (role defaults); members may create personal boards. */
export async function POST(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "reports", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await parseJson(req, DashboardInputSchema);
  if (!body.ok) return body.res;
  try {
    if ((body.data.role || body.data.is_default) && !scope.can("team", true)) return NextResponse.json({ error: "forbidden", detail: "Only admins can set role defaults." }, { status: 403 });
    const dashboard = await createDashboard(scope.dataId, scope.userId, body.data);
    await recordAudit(scope, { action: "dashboard.created", entity: "dashboard", entityId: dashboard.id, after: { name: dashboard.name, role: dashboard.role, is_default: dashboard.is_default }, req });
    return NextResponse.json({ dashboard }, { status: 201 });
  } catch (err) {
    return reportsError(err, "dashboards.POST");
  }
}
