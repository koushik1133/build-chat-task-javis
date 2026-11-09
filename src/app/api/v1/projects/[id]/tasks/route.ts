import { createProjectTask, listProjectTasks, requireProject } from "@/lib/projects/store";
import { ROUTES } from "@/lib/public-api/registry";
import { op, libCall, singlePage } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listProjectTasks, async ({ principal, params, query, list }) => {
  await libCall(() => requireProject(principal.dataId, params.id));
  const done = query.done === "true" ? true : query.done === "false" ? false : null;
  return singlePage(await listProjectTasks(principal.dataId, params.id, { done, milestoneId: query.milestone ?? null, assigneeId: query.assignee ?? null, limit: list.limit }));
});

export const POST = op(ROUTES.createProjectTask, async ({ principal, params, body }) => ({
  data: await libCall(() => createProjectTask(principal.dataId, params.id, body, { source: "api" })),
  status: 201,
}));
