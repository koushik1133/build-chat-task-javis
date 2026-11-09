import { getProject, updateProject } from "@/lib/projects/store";
import { ROUTES } from "@/lib/public-api/registry";
import { op, libCall, mustFind } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getProject, async ({ principal, params }) => ({ data: mustFind(await getProject(principal.dataId, params.id), "Project") }));

export const PATCH = op(ROUTES.updateProject, async ({ principal, params, body }) => ({ data: await libCall(() => updateProject(principal.dataId, params.id, body)) }));
