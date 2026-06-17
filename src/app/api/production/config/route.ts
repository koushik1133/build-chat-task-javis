import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { queryOne } from "@/lib/dsql";

const DEFAULT_COLUMNS = JSON.stringify([
  { id: "pending_approval", label: "Pending Approval", hitl: true, color: "#f59e0b" },
  { id: "todo", label: "To Do", hitl: false, color: "#6366f1" },
  { id: "done", label: "Done", hitl: false, color: "#22c55e" },
]);
const DEFAULT_FIELDS = JSON.stringify(["priority", "due_date", "tags"]);

export async function GET() {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  let config = await queryOne(
    "SELECT * FROM board_configs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
    [user.id]
  ).catch(() => null);

  if (!config) {
    // Auto-create default config
    config = await queryOne(
      `INSERT INTO board_configs (user_id, name, template, columns, card_fields)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [user.id, "My Board", "default", DEFAULT_COLUMNS, DEFAULT_FIELDS]
    ).catch(() => null);
  }

  return NextResponse.json({ config });
}

export async function POST(req: Request) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const body = await req.json();
  const { name, template, columns, card_fields } = body;

  // Upsert: try update first
  const existing = await queryOne(
    "SELECT id FROM board_configs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
    [user.id]
  ).catch(() => null);

  let config;
  if (existing) {
    config = await queryOne(
      `UPDATE board_configs SET name = $1, template = $2, columns = $3, card_fields = $4, updated_at = NOW()
       WHERE id = $5 RETURNING *`,
      [name ?? "My Board", template ?? "default", columns ?? DEFAULT_COLUMNS, card_fields ?? DEFAULT_FIELDS, existing.id]
    ).catch(() => null);
  } else {
    config = await queryOne(
      `INSERT INTO board_configs (user_id, name, template, columns, card_fields)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [user.id, name ?? "My Board", template ?? "default", columns ?? DEFAULT_COLUMNS, card_fields ?? DEFAULT_FIELDS]
    ).catch(() => null);
  }

  return NextResponse.json({ config });
}
