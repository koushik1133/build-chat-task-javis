import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { getPageViews } from "@/lib/dynamodb";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let supabase, user;
  try {
    ({ supabase, user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  // Verify the user owns this site via Supabase (RLS metadata check)
  const { data: site } = await supabase
    .from("sites")
    .select("id")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();
  if (!site) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Page-view events live in DynamoDB (high-throughput time-series store)
  const views = await getPageViews(id, 200).catch(() => []);
  const analytics = views.map((v) => ({
    id: v.evtId,
    path: v.path,
    user_agent: v.userAgent,
    created_at: v.createdAt,
  }));

  return NextResponse.json({ analytics });
}
