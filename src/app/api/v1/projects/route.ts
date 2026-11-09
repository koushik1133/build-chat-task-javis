import { createProject, listProjects } from "@/lib/projects/store";
import { ROUTES } from "@/lib/public-api/registry";
import { op, libCall } from "@/lib/public-api/handler";
import { page } from "@/lib/public-api/pagination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listProjects, async ({ principal, query, list }) => {
  const rows = await listProjects(principal.dataId, { status: query.status ?? null, includeArchived: query.archived === "true", cursor: list.cursor, limit: list.limit + 1 });
  const p = page(rows, list.limit, (r) => ({ created_at: r.created_at, id: r.id }));
  return { data: p.data, meta: { next_cursor: p.next_cursor } };
});

export const POST = op(ROUTES.createProject, async ({ principal, body }) => ({ data: await libCall(() => createProject(principal.dataId, body, `api_key:${principal.keyId}`)), status: 201 }));
