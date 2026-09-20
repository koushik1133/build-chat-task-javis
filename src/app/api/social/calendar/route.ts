import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { query } from "@/lib/dsql";

export async function GET(req: Request) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const userId = user.id;

  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from"); // YYYY-MM-DD
  const to = searchParams.get("to");     // YYYY-MM-DD

  let sql = `SELECT * FROM social_posts WHERE user_id = $1 AND scheduled_at IS NOT NULL`;
  const params: unknown[] = [userId];
  let idx = 2;

  if (from) { sql += ` AND scheduled_at >= $${idx++}`; params.push(from); }
  if (to)   { sql += ` AND scheduled_at <= $${idx++}`; params.push(`${to}T23:59:59`); }

  sql += " ORDER BY scheduled_at ASC";

  const posts = await query(sql, params);
  return NextResponse.json({ posts });
}
