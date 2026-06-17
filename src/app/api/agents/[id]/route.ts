import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { query, queryOne } from "@/lib/dsql";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const { id } = await ctx.params;
  const body = await req.json();

  if (body.status) {
    await query("UPDATE agents SET status = $1 WHERE id = $2 AND user_id = $3", [body.status, id, user.id]);
  }
  if (body.name?.trim()) {
    await query("UPDATE agents SET name = $1 WHERE id = $2 AND user_id = $3", [body.name.trim(), id, user.id]);
  }
  if (body.system_prompt !== undefined) {
    await query(
      "UPDATE agents SET system_prompt = $1 WHERE id = $2 AND user_id = $3",
      [body.system_prompt?.trim() || null, id, user.id]
    ).catch(() => {});
  }

  const agent = await queryOne("SELECT * FROM agents WHERE id = $1 AND user_id = $2", [id, user.id]);
  return NextResponse.json({ ok: true, agent });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const { id } = await ctx.params;
  await query("DELETE FROM agents WHERE id = $1 AND user_id = $2", [id, user.id]);
  return NextResponse.json({ ok: true });
}
