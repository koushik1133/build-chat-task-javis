import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { query } from "@/lib/dsql";
import { completeJson } from "@/lib/llm";
import { llmNotConfiguredResponse } from "@/lib/llm-response";
import { randomUUID } from "crypto";

export async function GET() {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const userId = user.id;

  const standups = await query(
    "SELECT * FROM agency_daily_standups WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50",
    [userId]
  );
  return NextResponse.json({ standups });
}

export async function POST(req: Request) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const userId = user.id;

  const rawBody = await req.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const body = rawBody;
  const { employee_id, employee_name, project_id, project_title, tasks_today, plan_tomorrow, blockers } = body;

  if (!employee_name || !tasks_today) {
    return NextResponse.json({ error: "Employee name and tasks_today are required" }, { status: 400 });
  }

  // AI Sentiment & Risk Analysis on Standup
  let riskLevel = "low";
  let aiSummary = "Progress on track.";

  try {
    const aiAnalysis = await completeJson<{ risk_level: string; summary: string }>(
      [
        {
          role: "system",
          content: `Analyze this developer daily standup log for project risks, technical blockers, or delays.
Return JSON with keys:
- risk_level: 'low', 'medium', or 'high'
- summary: concise 1-sentence executive summary for the agency boss`,
        },
        {
          role: "user",
          content: `Employee: ${employee_name}
Project: ${project_title || "General"}
Tasks completed today: ${tasks_today}
Tomorrow's plan: ${plan_tomorrow || "N/A"}
Blockers reported: ${blockers || "None"}`,
        },
      ],
      `{ risk_level: string; summary: string }`
    );

    if (aiAnalysis?.risk_level) riskLevel = aiAnalysis.risk_level.toLowerCase();
    if (aiAnalysis?.summary) aiSummary = aiAnalysis.summary;
  } catch (err) {
    const notConfigured = llmNotConfiguredResponse(err);
    if (notConfigured) return notConfigured;
    if (blockers && blockers.trim().length > 5) {
      riskLevel = "medium";
      aiSummary = `Blocker reported: ${blockers.slice(0, 80)}...`;
    }
  }

  const id = randomUUID();
  const [standup] = await query(
    `INSERT INTO agency_daily_standups
       (id, user_id, employee_id, employee_name, project_id, project_title, tasks_today, plan_tomorrow, blockers, risk_level, ai_summary)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      id,
      userId,
      employee_id ?? "emp-1",
      employee_name,
      project_id ?? null,
      project_title ?? null,
      tasks_today,
      plan_tomorrow ?? null,
      blockers ?? null,
      riskLevel,
      aiSummary,
    ]
  );

  return NextResponse.json({ standup });
}
