import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let supabase, user;
  try {
    ({ supabase, user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const { data: chat } = await supabase
    .from("chats")
    .select("id,title")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();
  if (!chat) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { data: messages } = await supabase
    .from("messages")
    .select("id,role,content,created_at")
    .eq("chat_id", id)
    .order("created_at", { ascending: true });

  return NextResponse.json({ chat, messages: messages ?? [] });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let supabase, user;
  try {
    ({ supabase, user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  await supabase.from("chats").delete().eq("id", id).eq("user_id", user.id);
  return NextResponse.json({ ok: true });
}
