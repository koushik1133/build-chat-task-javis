import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { query, queryOne } from "@/lib/dsql";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let user;
  try {
    ({ user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  // Application-layer ownership check (no FK / RLS in DSQL)
  const site = await queryOne("SELECT id FROM sites WHERE id = $1 AND user_id = $2", [id, user.id]);
  if (!site) return NextResponse.json({ error: "not found" }, { status: 404 });

  const revisions = await query(
    `SELECT id, source, prompt, created_at
     FROM site_revisions
     WHERE site_id = $1
     ORDER BY created_at ASC`,
    [id]
  );

  return NextResponse.json({ revisions });
}
