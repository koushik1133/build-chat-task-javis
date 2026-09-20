import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { query } from '@/lib/dsql';
import { complete } from '@/lib/llm';
import { llmNotConfiguredResponse } from '@/lib/llm-response';

export async function POST(req: Request) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rawBody = await req.json().catch(() => null);
    if (!rawBody || typeof rawBody !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    const body = rawBody;
    const { action, ...payload } = body as Record<string, unknown> & { action?: string };
    const text = (v: unknown, max = 8000) => (typeof v === "string" ? v.slice(0, max) : "");

    switch (action) {
      case 'add_donor': {
        const { full_name, email, phone, total_donated, cause_tags } = payload;
        

        const result = await query(
          `INSERT INTO nonprofit_donors (user_id, full_name, email, phone, total_donated, cause_tags) 
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [user.id, full_name, email, phone, total_donated, cause_tags]
        );
        return NextResponse.json({ donor: result[0] });
      }

      case 'generate_grant_proposal': {
        const { org_name, project_title, requested_amount, target_population } = payload;
        const mission = text(payload.mission);
        const impact_metrics = text(payload.impact_metrics);
        const prompt = `Write a grant proposal for:
        Organization: ${org_name}
        Mission: ${mission}
        Project Title: ${project_title}
        Requested Amount: $${requested_amount}
        Target Population: ${target_population}
        Impact Metrics: ${impact_metrics}
        
        Include an Executive Summary, Need Statement, Project Description, and Evaluation Plan.`;

        const proposal = await complete([{ role: 'user', content: prompt }]);
        return NextResponse.json({ proposal });
      }

      case 'generate_impact_report': {
        const { org_name, period, total_raised } = payload;
        const programs = JSON.stringify(payload.programs ?? []).slice(0, 8000);
        const prompt = `Write a compelling impact report narrative for the organization ${org_name} for the period ${period}.
        Total Raised: $${total_raised}
        Programs data: ${programs}
        Make it emotional and data-driven.`;

        const report = await complete([{ role: 'user', content: prompt }]);
        return NextResponse.json({ report });
      }

      case 'donor_retention_tips': {
        // Mocking the query logic as we don't know if the table exists or if data matches
        let at_risk_count = 0;
        try {
            const result = await query(`SELECT COUNT(*) FROM nonprofit_donors WHERE user_id = $1 AND last_donation < NOW() - INTERVAL '6 months'`, [user.id]);
            at_risk_count = parseInt(String(result[0]?.count ?? "0"), 10) || 0;
        } catch (e) {
            console.error("[domains/nonprofit] at-risk donor count failed:", e);
            at_risk_count = 0;
        }

        const prompt = `We have ${at_risk_count} donors who haven't donated in over 6 months. Provide personalized re-engagement strategies and donor retention tips to win them back. Return it as a plain list of actionable tips.`;
        
        const tips = await complete([{ role: 'user', content: prompt }]);
        return NextResponse.json({ tips, at_risk_count });
      }

      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (err) {
    const notConfigured = llmNotConfiguredResponse(err);
    if (notConfigured) return notConfigured;
    console.error("[domains/nonprofit] POST error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const action = searchParams.get('action');

    if (action === 'donors') {
      try {
        const donors = await query(
          'SELECT * FROM nonprofit_donors WHERE user_id = $1 ORDER BY total_donated DESC',
          [user.id]
        );
        return NextResponse.json({ donors });
      } catch (e) {
        console.error("[domains/nonprofit] donors query failed:", e);
        return NextResponse.json({ donors: [] });
      }
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (err) {
    console.error("[domains/nonprofit] GET error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
