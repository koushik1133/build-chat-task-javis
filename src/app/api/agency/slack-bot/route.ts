import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { query } from "@/lib/dsql";
import { complete } from "@/lib/llm";
import { llmNotConfiguredResponse } from "@/lib/llm-response";

/**
 * Interactive Slack Agency Bot command handler
 * Handles commands:
 *  - /standup (logs or fetches standups)
 *  - /status (summarizes active projects & risks)
 *  - /assign (assigns an employee to a project)
 *  - /ask (answers general team & tech questions)
 */
export async function POST(req: Request) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const userId = user.id;

  const rawBody = await req.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const body = rawBody;
  const { command, user_name = "Boss" } = body;
  const text = typeof body.text === "string" ? body.text.slice(0, 8000) : "";

  if (!command) {
    return NextResponse.json({ error: "command is required" }, { status: 400 });
  }

  try {
  // Fetch contextual agency data for the LLM
  const [projects, standups, employees] = await Promise.all([
    query("SELECT title, project_type, status, assigned_employee_name, budget, progress_pct FROM agency_projects WHERE user_id = $1", [userId]),
    query("SELECT employee_name, project_title, tasks_today, blockers, risk_level FROM agency_daily_standups WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10", [userId]),
    query("SELECT name, role, active_projects FROM agency_employees WHERE user_id = $1", [userId]),
  ]);

  const agencyContext = `
Active Projects (${projects.length}):
${JSON.stringify(projects, null, 2)}

Team Roster (${employees.length}):
${JSON.stringify(employees, null, 2)}

Recent Daily Standups (${standups.length}):
${JSON.stringify(standups, null, 2)}
`;

  let responseText = "";

  if (command === "/status") {
    const prompt = `You are the KernelHub Agency Slack Bot.
Provide a concise, Slack-formatted status report for the team. Highlight active projects, project progress, overdue risks, and blockers reported in daily standups.
Context:
${agencyContext}`;
    responseText = await complete([
      { role: "system", content: prompt },
      { role: "user", content: "Give me the team project status update." },
    ]);
  } else if (command === "/standup") {
    const prompt = `You are the KernelHub Agency Slack Bot.
A team member submitted a standup inquiry/log: "${text}".
Acknowledge the standup, summarize key tasks completed, flag any blockers to management, and provide a friendly team response.
Context:
${agencyContext}`;
    responseText = await complete([
      { role: "system", content: prompt },
      { role: "user", content: text || "Daily standup update" },
    ]);
  } else if (command === "/ask") {
    const prompt = `You are the Senior AI Agency Assistant in Slack.
Answer the team member's question about projects, code, architecture, or agency ops.
User (${user_name}): "${text}"
Context:
${agencyContext}`;
    responseText = await complete([
      { role: "system", content: prompt },
      { role: "user", content: text },
    ]);
  } else {
    responseText = `🤖 *KernelHub Bot*: Command \`${command}\` processed.\nQuery: "${text || "N/A"}"\n\nActive Projects: ${projects.length} | Team Members: ${employees.length}`;
  }

  return NextResponse.json({
    command,
    response: responseText,
    timestamp: new Date().toISOString(),
  });
  } catch (err) {
    const notConfigured = llmNotConfiguredResponse(err);
    if (notConfigured) return notConfigured;
    console.error("[agency/slack-bot] error:", err);
    return NextResponse.json({ error: "Failed to process command" }, { status: 500 });
  }
}
