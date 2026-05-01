import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/supabase/server";

export const runtime = "nodejs";

const Body = z.object({
  siteId: z.string().uuid(),
  html: z.string().min(20).max(500_000),
});

export async function POST(req: Request) {
  let supabase, user;
  try {
    ({ supabase, user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const { siteId, html } = parsed.data;

  if (!html.toLowerCase().includes("<!doctype")) {
    return NextResponse.json({ error: "invalid html" }, { status: 400 });
  }

  const { data: site, error: gErr } = await supabase
    .from("sites")
    .select("id")
    .eq("id", siteId)
    .single();
  if (gErr || !site)
    return NextResponse.json({ error: "site not found" }, { status: 404 });

  const { error: uErr } = await supabase
    .from("sites")
    .update({ html, updated_at: new Date().toISOString() })
    .eq("id", siteId);
  if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 });

  await supabase.from("site_revisions").insert({
    site_id: siteId,
    user_id: user.id,
    source: "manual",
    prompt: "inline edit",
    html,
  });

  return NextResponse.json({ ok: true });
}
