import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { query, queryOne } from "@/lib/dsql";

export async function GET() {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const notifications = await query(
    `SELECT id, title, body, read, created_at FROM notifications
     WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30`,
    [user.id]
  ).catch(() => []);

  const unread = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM notifications WHERE user_id = $1 AND read = false`,
    [user.id]
  ).catch(() => ({ count: "0" }));

  return NextResponse.json({ notifications, unread: parseInt(unread?.count ?? "0", 10) });
}

export async function PATCH(req: Request) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const { ids, all } = await req.json();

  if (all) {
    await query(`UPDATE notifications SET read = true WHERE user_id = $1`, [user.id]);
  } else if (Array.isArray(ids) && ids.length > 0) {
    for (const id of ids) {
      await query(`UPDATE notifications SET read = true WHERE id = $1 AND user_id = $2`, [id, user.id]);
    }
  }

  return NextResponse.json({ ok: true });
}
