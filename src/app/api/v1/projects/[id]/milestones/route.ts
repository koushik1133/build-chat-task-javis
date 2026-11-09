import { createMilestone, listMilestones, requireProject } from "@/lib/projects/store";
import { ROUTES } from "@/lib/public-api/registry";
import { op, libCall, singlePage } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listProjectMilestones, async ({ principal, params }) => {
  await libCall(() => requireProject(principal.dataId, params.id));
  return singlePage(await listMilestones(principal.dataId, params.id));
});

export const POST = op(ROUTES.createProjectMilestone, async ({ principal, params, body }) => ({ data: await libCall(() => createMilestone(principal.dataId, params.id, body)), status: 201 }));
