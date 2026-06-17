import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { query, queryOne } from "@/lib/dsql";
import { getAgentTemplate, getDefaultSystemPrompt } from "@/lib/agent-templates";

export async function GET() {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const agents = await query(
    "SELECT * FROM agents WHERE user_id = $1 ORDER BY created_at DESC",
    [user.id]
  ).catch(() => []);
  return NextResponse.json({ agents });
}

export async function POST(req: Request) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const { name, role, system_prompt, template_id } = await req.json();
  if (!name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });

  const template = template_id ? getAgentTemplate(template_id) : null;
  const resolvedRole = role ?? template?.role ?? "General Agent";
  const resolvedPrompt =
    system_prompt?.trim() || template?.system_prompt || getDefaultSystemPrompt(resolvedRole);

  const agent = await queryOne(
    `INSERT INTO agents (user_id, name, role, system_prompt, template_id, status, tasks_completed)
     VALUES ($1, $2, $3, $4, $5, 'idle', 0) RETURNING *`,
    [user.id, name.trim(), resolvedRole, resolvedPrompt, template_id ?? null]
  ).catch(async () =>
    queryOne(
      `INSERT INTO agents (user_id, name, role, status, tasks_completed)
       VALUES ($1, $2, $3, 'idle', 0) RETURNING *`,
      [user.id, name.trim(), resolvedRole]
    )
  );
  return NextResponse.json({ agent });
}
