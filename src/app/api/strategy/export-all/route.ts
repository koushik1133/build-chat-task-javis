import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { query } from "@/lib/dsql";

export async function GET() {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const proposals = await query(
    "SELECT id, title, type, status, content, created_at FROM strategies WHERE user_id = $1 ORDER BY created_at DESC",
    [user.id]
  ).catch(() => []);

  const blob = JSON.stringify({ exported_at: new Date().toISOString(), proposals }, null, 2);
  return new NextResponse(blob, {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": 'attachment; filename="kernelhub-strategies-export.json"',
    },
  });
}
