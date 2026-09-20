import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { query } from "@/lib/dsql";
import { completeJson } from "@/lib/llm";
import { llmNotConfiguredResponse } from "@/lib/llm-response";
import { randomUUID } from "crypto";

type GeneratedAudit = {
  ai_readiness_score: number;
  recommended_agents: string[];
  estimated_roi: string;
  audit_report: string;
};

export async function POST(req: Request) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const userId = user.id;

  const rawBody = await req.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const body = rawBody;
  const { client_name, industry = "Technology" } = body;
  const current_tech = typeof body.current_tech === "string" ? body.current_tech.slice(0, 8000) : "Legacy Web App";

  if (!client_name) {
    return NextResponse.json({ error: "client_name is required" }, { status: 400 });
  }

  const systemPrompt = `You are a Chief AI Officer at an AI Consulting Firm.
Perform a comprehensive AI Transformation Audit for a client.
Return ONLY valid JSON with keys:
- ai_readiness_score (integer 0-100 score indicating readiness to adopt AI automation)
- recommended_agents (array of 3-5 specific AI Agents or Chatbots that would transform their business)
- estimated_roi (concise string summarizing financial savings or output boost e.g. '3.5x ROI in 90 days, $45k annual savings')
- audit_report (markdown formatted executive summary report covering Opportunities, Tech Stack Upgrades, Implementation Roadmap)`;

  try {
  const aiResult = await completeJson<GeneratedAudit>(
    [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `Client Company: ${client_name}
Industry: ${industry}
Current Tech Stack/Workflow: ${current_tech}`,
      },
    ],
    `{ ai_readiness_score: number; recommended_agents: Array<string>; estimated_roi: string; audit_report: string }`
  );

  if (!aiResult) {
    return NextResponse.json({ error: "AI Audit generation failed. Please try again." }, { status: 500 });
  }

  const id = randomUUID();
  const [audit] = await query(
    `INSERT INTO agency_client_audits
       (id, user_id, client_name, industry, current_tech, ai_readiness_score, recommended_agents, estimated_roi, audit_report)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      id,
      userId,
      client_name,
      industry,
      current_tech,
      aiResult.ai_readiness_score,
      JSON.stringify(aiResult.recommended_agents),
      aiResult.estimated_roi,
      aiResult.audit_report,
    ]
  );

  return NextResponse.json({ audit });
  } catch (err) {
    const notConfigured = llmNotConfiguredResponse(err);
    if (notConfigured) return notConfigured;
    console.error("[agency/audits/generate] error:", err);
    return NextResponse.json({ error: "Failed to generate audit" }, { status: 500 });
  }
}

export async function GET() {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const audits = await query(
    "SELECT * FROM agency_client_audits WHERE user_id = $1 ORDER BY created_at DESC",
    [user.id]
  );
  return NextResponse.json({ audits });
}
