import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { query } from "@/lib/dsql";
import { completeJson } from "@/lib/llm";
import { llmNotConfiguredResponse } from "@/lib/llm-response";
import { randomUUID } from "crypto";

type GeneratedProposal = {
  technical_spec: string;
  architecture: string;
  milestones: string[];
  cost_estimate: number;
  estimated_days: number;
};

export async function POST(req: Request) {
  let scope;
  try { scope = await requireScope({ area: "crm", edit: true }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const userId = scope.dataId;

  const rawBody = await req.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const body = rawBody;
  const { client_name, project_type = "website" } = body;
  const raw_requirements = typeof body.raw_requirements === "string" ? body.raw_requirements.slice(0, 8000) : "";

  if (!client_name || !raw_requirements) {
    return NextResponse.json({ error: "client_name and raw_requirements are required" }, { status: 400 });
  }

  const systemPrompt = `You are a Senior Principal Solutions Architect at a top AI & Software Consultancy.
Given a client's project description and requirement, generate a comprehensive technical proposal.
Return ONLY valid JSON with keys:
- technical_spec (detailed technical description of the proposed solution)
- architecture (overview of the tech stack, frontend, backend, AI agents, database, infrastructure)
- milestones (array of 4-6 sequential delivery milestones with timeline estimates)
- cost_estimate (suggested project price in USD, integer e.g. 12500)
- estimated_days (integer estimated total business days e.g. 21)`;

  try {
  const aiResult = await completeJson<GeneratedProposal>(
    [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `Client Name: ${client_name}
Project Type: ${project_type}
Raw Requirements: ${raw_requirements}`,
      },
    ],
    `{ technical_spec: string; architecture: string; milestones: Array<string>; cost_estimate: number; estimated_days: number }`
  );

  if (!aiResult) {
    return NextResponse.json({ error: "AI Proposal generation failed. Please try again." }, { status: 500 });
  }

  const id = randomUUID();
  const [proposal] = await query(
    `INSERT INTO agency_proposals
       (id, user_id, client_name, project_type, raw_requirements, technical_spec, architecture, milestones, cost_estimate, estimated_days, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft')
     RETURNING *`,
    [
      id,
      userId,
      client_name,
      project_type,
      raw_requirements,
      aiResult.technical_spec,
      aiResult.architecture,
      JSON.stringify(aiResult.milestones),
      aiResult.cost_estimate,
      aiResult.estimated_days,
    ]
  );

  return NextResponse.json({ proposal });
  } catch (err) {
    const notConfigured = llmNotConfiguredResponse(err);
    if (notConfigured) return notConfigured;
    console.error("[agency/proposals/generate] error:", err);
    return NextResponse.json({ error: "Failed to generate proposal" }, { status: 500 });
  }
}

export async function GET() {
  let scope;
  try { scope = await requireScope({ area: "crm", edit: false }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const proposals = await query(
    "SELECT * FROM agency_proposals WHERE user_id = $1 ORDER BY created_at DESC",
    [scope.dataId]
  );
  return NextResponse.json({ proposals });
}
