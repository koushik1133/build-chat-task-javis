import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let supabase;
  try {
    ({ supabase } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  // RLS policy "owner reads analytics" guarantees we only see our own site's analytics
  const { data: analytics, error } = await supabase
    .from("site_analytics")
    .select("id, path, user_agent, created_at")
    .eq("site_id", id)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ analytics });
}
