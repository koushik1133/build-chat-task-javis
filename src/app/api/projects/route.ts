import { NextResponse, type NextRequest } from "next/server";
import { recordAudit } from "@/lib/audit";
import { parseBody } from "@/lib/money/http";
import { normaliseCursor, page, parseListParams } from "@/lib/public-api/pagination";
import { projectBudget } from "@/lib/projects/budget";
import { projectError, projectScope } from "@/lib/projects/http";
import { projectProgress } from "@/lib/projects/progress";
import { PROJECT_STATUSES, ProjectInputSchema, type ProjectStatus } from "@/lib/projects/pure";
import { createProject, listProjects } from "@/lib/projects/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/projects?status=&q=&archived=1&cursor=&limit=&summary=1 — summary adds progress + budget per project. */
export async function GET(req: NextRequest) {
  const s = await projectScope(req, false);
  if (!s.ok) return s.res;
  try {
    const sp = req.nextUrl.searchParams;
    const list = parseListParams(req.nextUrl, { limit: 50 });
    if (list.badCursor) return NextResponse.json({ error: "invalid cursor" }, { status: 400 });
    const statusRaw = sp.get("status");
    const status = statusRaw && (PROJECT_STATUSES as readonly string[]).includes(statusRaw) ? (statusRaw as ProjectStatus) : null;
    const rows = await listProjects(s.scope.dataId, { status, q: sp.get("q"), includeArchived: sp.get("archived") === "1", cursor: list.cursor, limit: list.limit + 1 });
    const pg = page(rows, list.limit, (r) => normaliseCursor({ created_at: r.created_at, id: r.id }));
    if (sp.get("summary") !== "1") return NextResponse.json({ projects: pg.data, next_cursor: pg.next_cursor });
    const projects = await Promise.all(
      pg.data.map(async (p) => {
        const [progress, budget] = await Promise.all([projectProgress(s.scope.dataId, p.id).catch(() => null), projectBudget(s.scope.dataId, p).catch(() => null)]);
        return { ...p, progress, budget };
      })
    );
    return NextResponse.json({ projects, next_cursor: pg.next_cursor });
  } catch (err) {
    return projectError(err, "projects.list");
  }
}

/** POST /api/projects — create. */
export async function POST(req: NextRequest) {
  const s = await projectScope(req, true);
  if (!s.ok) return s.res;
  const parsed = await parseBody(req, ProjectInputSchema, 65_536);
  if (!parsed.ok) return parsed.res;
  try {
    const project = await createProject(s.scope.dataId, parsed.data, s.scope.userId);
    void recordAudit(s.scope, { action: "create", entity: "project", entityId: project.id, after: { name: project.name, status: project.status, budget_minor: project.budget_minor }, req }).catch(() => undefined);
    return NextResponse.json({ project }, { status: 201 });
  } catch (err) {
    return projectError(err, "projects.create");
  }
}
