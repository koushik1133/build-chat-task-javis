import { NextResponse } from "next/server";
import { query } from "@/lib/dsql";
import { createClient } from "@/lib/supabase/server";
import { complete } from "@/lib/llm";
import { llmNotConfiguredResponse } from "@/lib/llm-response";
import { parseModelJson } from "@/lib/model-json";

export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");

  if (action === "cases") {
    try {
      const cases = await query(
        `SELECT * FROM legal_cases WHERE user_id = $1 ORDER BY created_at DESC`,
        [user.id]
      );
      return NextResponse.json({ cases });
    } catch (e) {
      console.error(e);
      return NextResponse.json({ cases: [] });
    }
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rawBody = await req.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const body = rawBody;
  const { action } = body;
  const text = (v: unknown, max = 8000) => (typeof v === "string" ? v.slice(0, max) : "");

  try {
    if (action === "create_case") {
      const { case_name, client_name, case_type } = body;
      

      const newCase = await query(
        `INSERT INTO legal_cases (user_id, case_name, client_name, case_type) VALUES ($1, $2, $3, $4) RETURNING *`,
        [user.id, case_name, client_name, case_type]
      );
      return NextResponse.json({ case: newCase[0] });
    }

    if (action === "analyze_contract") {
      const { focus_areas } = body;
      const contract_text = text(body.contract_text);
      const prompt = `Analyze this contract text: "${contract_text}". Focus areas: ${focus_areas || 'General'}. Return JSON with { "key_clauses": [""], "risks": [""], "red_flags": [""], "recommendations": [""] }`;
      
      const response = await complete([{ role: "user", content: prompt }]);
      const analysis = parseModelJson(response);
      if (!analysis) {
        return NextResponse.json({ error: "The model returned an unreadable response. Please try again." }, { status: 502 });
      }
      return NextResponse.json({ analysis });
    }

    if (action === "research_legal_topic") {
      const { jurisdiction } = body;
      const searchQuery = text(body.query);
      const prompt = `Provide a legal research summary for: "${searchQuery}" in jurisdiction: "${jurisdiction || 'General'}". Include key points and caveats. Format as markdown.`;
      
      const research = await complete([{ role: "user", content: prompt }]);
      return NextResponse.json({ research });
    }

    if (action === "generate_timeline") {
      const { case_name } = body;
      const events = JSON.stringify(body.events ?? []).slice(0, 8000);
      const prompt = `Organize and annotate this legal timeline for case "${case_name}": ${events}. Return markdown formatted timeline with professional analysis of the sequence of events.`;
      
      const timeline = await complete([{ role: "user", content: prompt }]);
      return NextResponse.json({ timeline });
    }

    if (action === "log_billing") {
      const { case_id, hours, rate, description } = body;
      
      const currentCaseResult = await query(
        `SELECT billing_log FROM legal_cases WHERE id = $1 AND user_id = $2`,
        [case_id, user.id]
      );
      
      if (!currentCaseResult.length) {
        return NextResponse.json({ error: "Case not found" }, { status: 404 });
      }
      
      let billingLog = [];
      try {
        billingLog = JSON.parse(currentCaseResult[0].billing_log || '[]');
      } catch {
        billingLog = [];
      }
      
      billingLog.push({
        id: crypto.randomUUID(),
        hours: Number(hours),
        rate: Number(rate),
        description,
        date: new Date().toISOString()
      });
      
      const updatedCaseResult = await query(
        `UPDATE legal_cases SET billing_log = $1 WHERE id = $2 AND user_id = $3 RETURNING *`,
        [JSON.stringify(billingLog), case_id, user.id]
      );
      
      return NextResponse.json({ updated_case: updatedCaseResult[0] });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    const notConfigured = llmNotConfiguredResponse(err);
    if (notConfigured) return notConfigured;
    console.error("[domains/legal] POST error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
