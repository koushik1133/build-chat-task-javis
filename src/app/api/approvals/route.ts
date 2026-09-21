import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { query, queryOne } from "@/lib/dsql";

const STATUSES = new Set(["pending", "approved", "rejected", "expired"]);
const EXPIRE_AFTER = "7 days";

/** Columns safe to hand to the UI — never checkpoint/runtime internals. */
const PUBLIC_COLUMNS = `
  a.id, a.run_id, a.agent_id, a.tool_name, a.input, a.preview, a.status,
  a.decided_by, a.decided_at, a.expires_at, a.created_at, ag.name AS agent_name`;

async function expireStale(userId: string) {
  await query(
    `UPDATE approvals SET status = 'expired'
     WHERE user_id = $1 AND status = 'pending'
       AND (expires_at < NOW() OR created_at < NOW() - INTERVAL '${EXPIRE_AFTER}')`,
    [userId]
  ).catch(() => {});
}

export async function GET(req: Request) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? "pending";
  if (!STATUSES.has(status)) return NextResponse.json({ error: "invalid status" }, { status: 400 });

  await expireStale(user.id);

  if (url.searchParams.get("count") === "1") {
    const row = await queryOne<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM approvals WHERE user_id = $1 AND status = $2`,
      [user.id, status]
    ).catch(() => null);
    return NextResponse.json({ count: Number(row?.n ?? 0) });
  }

  const approvals = await query(
    `SELECT ${PUBLIC_COLUMNS} FROM approvals a
     LEFT JOIN agents ag ON ag.id::text = a.agent_id
     WHERE a.user_id = $1 AND a.status = $2
     ORDER BY a.created_at DESC LIMIT 100`,
    [user.id, status]
  ).catch(() => null);
  if (!approvals) return NextResponse.json({ error: "failed to load approvals" }, { status: 500 });
  return NextResponse.json({ approvals });
}
