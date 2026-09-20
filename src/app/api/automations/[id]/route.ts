import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { query } from "@/lib/dsql";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const { id } = await ctx.params;
  const rawBody = await req.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const { status } = rawBody;
  await query("UPDATE automations SET status = $1 WHERE id = $2 AND user_id = $3", [status, id, user.id]);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const { id } = await ctx.params;
  await query("DELETE FROM automations WHERE id = $1 AND user_id = $2", [id, user.id]);
  return NextResponse.json({ ok: true });
}
