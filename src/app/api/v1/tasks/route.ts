import { createTask, listTasks } from "@/lib/tasks/store";
import { ROUTES } from "@/lib/public-api/registry";
import { op } from "@/lib/public-api/handler";
import { page } from "@/lib/public-api/pagination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listTasks, async ({ principal, query, list }) => {
  const done = query.done === "true" ? true : query.done === "false" ? false : null;
  const rows = await listTasks(principal.dataId, { done, assigneeId: query.assignee_id ?? null, overdue: query.overdue === "true", cursor: list.cursor, limit: list.limit + 1 });
  const p = page(rows, list.limit, (r) => ({ created_at: r.created_at, id: r.id }));
  return { data: p.data, meta: { next_cursor: p.next_cursor } };
});

export const POST = op(ROUTES.createTask, async ({ principal, body }) => ({ data: await createTask(principal.dataId, body, "api"), status: 201 }));
