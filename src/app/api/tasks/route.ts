import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/supabase/server";

export async function GET() {
  let supabase, user;
  try {
    ({ supabase, user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { data } = await supabase
    .from("tasks")
    .select("id,title,done,created_at,chat_id")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(100);
  return NextResponse.json({ tasks: data ?? [] });
}

const Patch = z.object({
  id: z.string().uuid(),
  done: z.boolean().optional(),
  title: z.string().min(1).max(200).optional(),
});

export async function PATCH(req: Request) {
  let supabase, user;
  try {
    ({ supabase, user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = Patch.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const { id, ...patch } = parsed.data;
  await supabase.from("tasks").update(patch).eq("id", id).eq("user_id", user.id);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  let supabase, user;
  try {
    ({ supabase, user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await req.json();
  await supabase.from("tasks").delete().eq("id", id).eq("user_id", user.id);
  return NextResponse.json({ ok: true });
}

const Create = z.object({ title: z.string().min(1).max(200) });

export async function POST(req: Request) {
  let supabase, user;
  try {
    ({ supabase, user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = Create.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const { data } = await supabase
    .from("tasks")
    .insert({ user_id: user.id, title: parsed.data.title })
    .select("id,title,done,created_at")
    .single();
  return NextResponse.json({ task: data });
}
