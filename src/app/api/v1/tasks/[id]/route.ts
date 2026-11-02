import { deleteTask, getTask, updateTask } from "@/lib/tasks/store";
import { ROUTES } from "@/lib/public-api/registry";
import { ApiError } from "@/lib/public-api/envelope";
import { op, mustFind } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getTask, async ({ principal, params }) => ({ data: mustFind(await getTask(principal.dataId, params.id), "Task") }));

export const PATCH = op(ROUTES.updateTask, async ({ principal, params, body }) => ({ data: await updateTask(principal.dataId, params.id, body) }));

export const DELETE = op(ROUTES.deleteTask, async ({ principal, params }) => {
  if (!(await deleteTask(principal.dataId, params.id))) throw ApiError.notFound("Task");
  return { data: { id: params.id, deleted: true as const } };
});
