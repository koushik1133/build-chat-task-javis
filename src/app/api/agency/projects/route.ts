import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { query } from "@/lib/dsql";
import { randomUUID } from "crypto";

export async function GET(req: Request) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const userId = user.id;

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");
  const projectType = searchParams.get("type");

  let sql = "SELECT * FROM agency_projects WHERE user_id = $1";
  const params: unknown[] = [userId];
  let idx = 2;

  if (status) {
    sql += ` AND status = $${idx++}`;
    params.push(status);
  }
  if (projectType) {
    sql += ` AND project_type = $${idx++}`;
    params.push(projectType);
  }

  sql += " ORDER BY created_at DESC";

  const projects = await query(sql, params);
  return NextResponse.json({ projects });
}

export async function POST(req: Request) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const userId = user.id;

  const rawBody = await req.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const body = rawBody;
  const {
    client_id,
    title,
    project_type = "website",
    assigned_employee_id,
    assigned_employee_name,
    budget = 0,
    deadline,
    deliverable_link,
    repo_url,
  } = body;

  if (!title) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }

  const id = randomUUID();
  const [project] = await query(
    `INSERT INTO agency_projects
       (id, user_id, client_id, title, project_type, assigned_employee_id, assigned_employee_name, status, progress_pct, budget, deadline, deliverable_link, repo_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'intake', 0, $8, $9, $10, $11)
     RETURNING *`,
    [
      id,
      userId,
      client_id ?? null,
      title,
      project_type,
      assigned_employee_id ?? null,
      assigned_employee_name ?? null,
      budget,
      deadline ? new Date(deadline).toISOString() : null,
      deliverable_link ?? null,
      repo_url ?? null,
    ]
  );

  // Update employee's active project count if assigned
  if (assigned_employee_id) {
    await query(
      "UPDATE agency_employees SET active_projects = active_projects + 1 WHERE id = $1 AND user_id = $2",
      [assigned_employee_id, userId]
    );
  }

  return NextResponse.json({ project });
}

export async function PATCH(req: Request) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const userId = user.id;

  const rawBody = await req.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const body = rawBody;
  const { id, ...updates } = body;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const allowed = [
    "title",
    "project_type",
    "assigned_employee_id",
    "assigned_employee_name",
    "status",
    "progress_pct",
    "budget",
    "deadline",
    "deliverable_link",
    "repo_url",
  ];
  const fields = Object.keys(updates).filter(k => allowed.includes(k));
  if (fields.length === 0) return NextResponse.json({ error: "No valid fields" }, { status: 400 });

  const setClauses = fields.map((f, i) => `${f} = $${i + 3}`).join(", ");
  const updatesMap = updates as Record<string, unknown>;
  const values = [userId, id, ...fields.map(f => updatesMap[f])];

  const [project] = await query(
    `UPDATE agency_projects SET ${setClauses}, updated_at = NOW() WHERE user_id = $1 AND id = $2 RETURNING *`,
    values
  );

  return NextResponse.json({ project });
}

export async function DELETE(req: Request) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const userId = user.id;

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  await query("DELETE FROM agency_projects WHERE id = $1 AND user_id = $2", [id, userId]);
  return NextResponse.json({ success: true });
}
