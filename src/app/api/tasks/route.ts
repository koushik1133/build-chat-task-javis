import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/supabase/server";
import { query, queryOne } from "@/lib/dsql";

export async function GET() {
  let user;
  try {
    ({ user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const tasks = await query(
    `SELECT id, title, done, created_at, chat_id
     FROM tasks
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 100`,
    [user.id]
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
  let user;
  try {
    ({ user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = Patch.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const { id, done, title } = parsed.data;

  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (done !== undefined) { sets.push(`done = $${i++}`); vals.push(done); }
  if (title !== undefined) { sets.push(`title = $${i++}`); vals.push(title); }
  if (sets.length === 0) return NextResponse.json({ ok: true });

  vals.push(id, user.id);
  await query(
    `UPDATE tasks SET ${sets.join(", ")} WHERE id = $${i++} AND user_id = $${i}`,
    vals
  );

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  let user;
  try {
    ({ user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await req.json();
  await query("DELETE FROM tasks WHERE id = $1 AND user_id = $2", [id, user.id]);
  return NextResponse.json({ ok: true });
}

const Create = z.object({ title: z.string().min(1).max(200) });

export async function POST(req: Request) {
  let user;
  try {
    ({ user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = Create.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });

  const task = await queryOne(
    `INSERT INTO tasks (user_id, title)
     VALUES ($1, $2)
     RETURNING id, title, done, created_at`,
    [user.id, parsed.data.title]
  );

  return NextResponse.json({ task });
}
