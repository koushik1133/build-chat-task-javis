import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { query } from "@/lib/dsql";
import { randomUUID } from "crypto";

export async function GET() {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const userId = user.id;

  const employees = await query(
    "SELECT * FROM agency_employees WHERE user_id = $1 ORDER BY name ASC",
    [userId]
  );
  return NextResponse.json({ employees });
}

export async function POST(req: Request) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const userId = user.id;

  const rawBody = await req.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const body = rawBody;
  const { name, email, role = "Full Stack Engineer", skills, slack_handle } = body;

  if (!name) {
    return NextResponse.json({ error: "Employee name is required" }, { status: 400 });
  }

  const id = randomUUID();
  const [employee] = await query(
    `INSERT INTO agency_employees (id, user_id, name, email, role, skills, slack_handle, active_projects)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0)
     RETURNING *`,
    [id, userId, name, email ?? null, role, skills ?? null, slack_handle ?? `@${name.toLowerCase().replace(/\s+/g, "")}`]
  );

  return NextResponse.json({ employee });
}

export async function DELETE(req: Request) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const userId = user.id;

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  await query("DELETE FROM agency_employees WHERE id = $1 AND user_id = $2", [id, userId]);
  return NextResponse.json({ success: true });
}
