import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { query } from "@/lib/dsql";

export const runtime = "nodejs";

export async function GET() {
  let user;
  try {
    ({ user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sites = await query(
    `SELECT id, title, persona, updated_at
     FROM sites
     WHERE user_id = $1
     ORDER BY updated_at DESC
     LIMIT 50`,
    [user.id]
  ).catch((err) => {
    console.error("[sites] list failed:", err);
    return [];
  });

  return NextResponse.json({ sites });
}
