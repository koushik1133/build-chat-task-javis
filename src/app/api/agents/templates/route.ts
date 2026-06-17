import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { queryOne } from "@/lib/dsql";
import { completeJson } from "@/lib/llm";
import { getAgentTemplate, AGENT_TEMPLATES } from "@/lib/agent-templates";

export async function GET() {
  return NextResponse.json({ templates: AGENT_TEMPLATES });
}

export async function POST(req: Request) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const { template_id, system_prompt, type = "system" } = await req.json();
  const template = template_id ? getAgentTemplate(template_id) : null;

  const profile = await queryOne<{ company_name: string; industry: string; product_desc: string }>(
    `SELECT company_name, industry, product_desc FROM business_profile WHERE user_id = $1`,
    [user.id]
  ).catch(() => null);

  const biz = profile
    ? `Company: ${profile.company_name}, Industry: ${profile.industry}. ${profile.product_desc ?? ""}`
    : "A small business using Javis.";

  const basePrompt = system_prompt?.trim() || template?.system_prompt || "";

  if (type === "tasks") {
    const suggestions = template?.example_tasks ?? [
      "Daily brief for my business",
      "Top priorities for today",
      "Weekly summary and next steps",
    ];
    return NextResponse.json({ suggestions });
  }

  const result = await completeJson<{ suggestions: string[] }>(
    [
      {
        role: "system",
        content: "You generate alternative AI agent system prompts. Return exactly 3 variants as JSON.",
      },
      {
        role: "user",
        content: `Business context: ${biz}
Agent type: ${template?.name ?? "General Agent"}
Current system prompt:
${basePrompt}

Generate 3 improved alternative system prompts (each 2-4 sentences, specific to this business).`,
      },
    ],
    `{ "suggestions": string[] }`
  ).catch(() => null);

  const suggestions = result?.suggestions?.filter(Boolean).slice(0, 3);
  if (suggestions?.length) {
    return NextResponse.json({ suggestions });
  }

  return NextResponse.json({
    suggestions: [
      basePrompt,
      `${basePrompt}\n\nTailor every response to ${profile?.company_name ?? "the user's business"} in ${profile?.industry ?? "their industry"}.`,
      `You are a ${template?.name ?? "business"} agent for ${profile?.company_name ?? "this company"}. Be concise, use bullet points, and end with one recommended next action.`,
    ],
  });
}
