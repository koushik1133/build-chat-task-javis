import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { query } from "@/lib/dsql";

export async function GET(req: Request) {
  let scope;
  try { scope = await requireScope({ area: "social", edit: false }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const userId = scope.dataId;

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
