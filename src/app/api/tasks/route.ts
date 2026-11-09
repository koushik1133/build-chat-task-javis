import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { normaliseCursor, page, parseListParams } from "@/lib/public-api/pagination";
import { createTask, deleteTask, listTasks, TASK_PRIORITIES, updateTask, TaskInputError } from "@/lib/tasks/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DueAt = z.string().datetime({ offset: true }).nullable();

/** GET /api/tasks?cursor=&limit=&assignee=&overdue=1 — keyset-paginated, newest first (default 50 + next_cursor). */
export async function GET(req: Request) {
  let scope;
  try {
    scope = await requireScope({ area: "tasks", edit: false });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const list = parseListParams(url, { limit: 50 });
  if (list.badCursor) return NextResponse.json({ error: "invalid cursor" }, { status: 400 });
  const assignee = url.searchParams.get("assignee");
  const overdue = url.searchParams.get("overdue") === "1";

  const rows = await listTasks(scope.dataId, {
    cursor: list.cursor,
    limit: list.limit + 1,
    assigneeId: assignee === "me" ? scope.userId : assignee || null,
    overdue,
  }).catch((err) => {
    console.error("[tasks] list failed:", err);
    return [];
  });

  const pg = page(rows, list.limit, (r) => normaliseCursor(r));
  return NextResponse.json({ tasks: pg.data, next_cursor: pg.next_cursor });
}

const Patch = z
  .object({
    id: z.string().uuid(),
    done: z.boolean().optional(),
    title: z.string().trim().min(1).max(200).optional(),
    due_at: DueAt.optional(),
    assignee_id: z.string().trim().min(1).max(100).nullable().optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
  })
  .strict();

export async function PATCH(req: Request) {
  let scope;
  try {
    scope = await requireScope({ area: "tasks", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad request", details: parsed.error.flatten() }, { status: 400 });
  const { id, ...patch } = parsed.data;
  try {
    const task = await updateTask(scope.dataId, id, patch);
    return NextResponse.json({ ok: true, task });
  } catch (err) {
    if (err instanceof Error && err.message === "Task not found") return NextResponse.json({ error: "not found" }, { status: 404 });
    if (err instanceof TaskInputError) return NextResponse.json({ error: err.message }, { status: 400 });
    console.error("[tasks] update failed:", err);
    return NextResponse.json({ error: "Could not update the task" }, { status: 500 });
  }
}

const Delete = z.object({ id: z.string().uuid() }).strict();

export async function DELETE(req: Request) {
  let scope;
  try {
    scope = await requireScope({ area: "tasks", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = Delete.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  await deleteTask(scope.dataId, parsed.data.id);
  return NextResponse.json({ ok: true });
}

const Create = z
  .object({
    title: z.string().trim().min(1).max(200),
    due_at: DueAt.optional(),
    assignee_id: z.string().trim().min(1).max(100).nullable().optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
  })
  .strict();

export async function POST(req: Request) {
  let scope;
  try {
    scope = await requireScope({ area: "tasks", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = Create.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad request", details: parsed.error.flatten() }, { status: 400 });

  try {
    const task = await createTask(scope.dataId, parsed.data, "app");
    return NextResponse.json({ task });
  } catch (err) {
    if (err instanceof TaskInputError) return NextResponse.json({ error: err.message }, { status: 400 });
    console.error("[tasks] create failed:", err);
    return NextResponse.json({ error: "Could not create the task" }, { status: 500 });
  }
}
