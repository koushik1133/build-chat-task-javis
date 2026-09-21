import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { query, queryOne } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";

export async function GET() {
  let scope;
  try {
    scope = await requireScope({ area: "tasks", edit: false });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const tasks = await query(
    `SELECT id, title, done, created_at, chat_id
     FROM tasks
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 100`,
    [scope.dataId]
  ).catch((err) => {
    console.error("[tasks] list failed:", err);
    return [];
  });

  return NextResponse.json({ tasks });
}

const Patch = z.object({
  id: z.string().uuid(),
  done: z.boolean().optional(),
  title: z.string().min(1).max(200).optional(),
});

export async function PATCH(req: Request) {
  let scope;
  try {
    scope = await requireScope({ area: "tasks", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const { id, done, title } = parsed.data;

  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (done !== undefined) { sets.push(`done = $${i++}`); vals.push(done); }
  if (title !== undefined) { sets.push(`title = $${i++}`); vals.push(title); }
  if (sets.length === 0) return NextResponse.json({ ok: true });

  vals.push(id, scope.dataId);
  await query(
    `UPDATE tasks SET ${sets.join(", ")} WHERE id = $${i++} AND user_id = $${i}`,
    vals
  );

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  let scope;
  try {
    scope = await requireScope({ area: "tasks", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const rawBody = await req.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const { id } = rawBody;
  await query("DELETE FROM tasks WHERE id = $1 AND user_id = $2", [id, scope.dataId]);
  return NextResponse.json({ ok: true });
}

const Create = z.object({ title: z.string().min(1).max(200) });

export async function POST(req: Request) {
  let scope;
  try {
    scope = await requireScope({ area: "tasks", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = Create.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });

  const task = await queryOne(
    `INSERT INTO tasks (user_id, title)
     VALUES ($1, $2)
     RETURNING id, title, done, created_at`,
    [scope.dataId, parsed.data.title]
  );

  if (task) void emitEvent(scope.dataId, { type: "task.created", entity: "task", entityId: String((task as { id: string }).id), data: { title: parsed.data.title } });

  return NextResponse.json({ task });
}
