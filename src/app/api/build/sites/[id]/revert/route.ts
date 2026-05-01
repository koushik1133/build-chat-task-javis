import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/supabase/server";

export const runtime = "nodejs";

const Body = z.object({ revisionId: z.string().uuid() });

// Reverts sites.html to the html stored in a specific revision.
// Does NOT insert a new revision row — this is true undo/redo navigation.
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  let supabase;
  try {
    ({ supabase } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success)
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  const { id } = await ctx.params;
  const { revisionId } = parsed.data;

  const { data: rev, error: rErr } = await supabase
    .from("site_revisions")
    .select("html,site_id")
    .eq("id", revisionId)
    .single();
  if (rErr || !rev || rev.site_id !== id) {
    return NextResponse.json({ error: "revision not found" }, { status: 404 });
  }

  const { error: uErr } = await supabase
    .from("sites")
    .update({ html: rev.html, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, html: rev.html });
}
