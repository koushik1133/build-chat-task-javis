import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { getPageViews } from "@/lib/dynamodb";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let scope;
  try {
    scope = await requireScope({ area: "sites", edit: false });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const supabase = createAdminClient();

  const { id } = await params;

  // Verify the user owns this site via Supabase (RLS metadata check)
  const { data: site } = await supabase
    .from("sites")
    .select("id")
    .eq("id", id)
    .eq("user_id", scope.dataId)
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
