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

  // Application-layer ownership check
  const site = await queryOne("SELECT id FROM sites WHERE id = $1 AND user_id = $2", [id, user.id]);
  if (!site) return NextResponse.json({ error: "not found" }, { status: 404 });

  const rows = await query(
    `SELECT id, data, created_at
     FROM site_leads
     WHERE site_id = $1
     ORDER BY created_at DESC`,
    [id]
  );

  // data is stored as JSON text — parse it back
  const leads = rows.map((r) => ({
    id: r.id,
    created_at: r.created_at,
    data: r.data ? JSON.parse(r.data as string) : {},
  }));

  return NextResponse.json({ leads });
}
