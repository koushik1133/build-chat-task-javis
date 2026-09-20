import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/dsql";
import { createClient } from "@/lib/supabase/server";
import { complete } from "@/lib/llm";
import { llmNotConfiguredResponse } from "@/lib/llm-response";

// ─── Business/Startup Domain API ──────────────────────────────────────────────

export async function GET(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const action = new URL(req.url).searchParams.get("action") ?? "investors";

    if (action === "investors") {
      const rows = await query(
        `SELECT * FROM business_investors WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [user.id]
      );
      return NextResponse.json({ investors: rows });
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err: unknown) {
    console.error("[domains/business] GET error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const rawBody = await req.json().catch(() => null);
    if (!rawBody || typeof rawBody !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    const body = rawBody;
    const { action } = body;

    // ── Add Investor ──────────────────────────────────────────────────────────
    if (action === "add_investor") {
      const { investor_name, firm, email, check_size, focus_areas, stage = "identified", notes } = body;
      if (!investor_name?.trim()) return NextResponse.json({ error: "investor_name required" }, { status: 400 });

      const rows = await query(
        `INSERT INTO business_investors (user_id, investor_name, firm, email, check_size, focus_areas, stage, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [user.id, investor_name.trim(), firm ?? null, email ?? null, check_size ?? null, focus_areas ?? null, stage, notes ?? null]
      );
      return NextResponse.json({ investor: rows[0] }, { status: 201 });
    }

    // ── Update Investor Stage ─────────────────────────────────────────────────
    if (action === "update_stage") {
      const { id, stage } = body;
      if (!id || !stage) return NextResponse.json({ error: "id and stage required" }, { status: 400 });
      const rows = await query(
        `UPDATE business_investors SET stage = $1 WHERE id = $2 AND user_id = $3 RETURNING *`,
        [stage, id, user.id]
      );
      return NextResponse.json({ investor: rows[0] });
    }

    // ── Generate Pitch Deck Outline ───────────────────────────────────────────
    if (action === "generate_pitch") {
      const { company_name, target_market, traction, funding_ask, use_of_funds } = body;
      const product_desc = typeof body.product_desc === "string" ? body.product_desc.slice(0, 8000) : "";
      if (!company_name?.trim() || !product_desc.trim()) {
        return NextResponse.json({ error: "company_name and product_desc required" }, { status: 400 });
      }

      const pitch = await complete([
        {
          role: "user",
          content: `You are a startup pitch expert. Create a comprehensive pitch deck outline for the following startup:

Company: ${company_name}
Product/Service: ${product_desc}
Target Market: ${target_market ?? "Not specified"}
Traction: ${traction ?? "Early stage"}
Funding Ask: ${funding_ask ?? "Not specified"}
Use of Funds: ${use_of_funds ?? "Not specified"}

Generate a 12-slide pitch deck outline. For each slide, provide:
1. Slide title
2. 3-4 bullet points with specific content to include
3. One key data point or metric to highlight

Format as structured text with clear slide separations.`
        }
      ], { maxTokens: 2048 });

      return NextResponse.json({ pitch_outline: pitch });
    }

    // ── GTM Strategy ─────────────────────────────────────────────────────────
    if (action === "gtm_strategy") {
      const { company_name, target_market, budget_range, timeframe } = body;
      const product_desc = typeof body.product_desc === "string" ? body.product_desc.slice(0, 8000) : undefined;
      if (!company_name?.trim()) return NextResponse.json({ error: "company_name required" }, { status: 400 });

      const gtm = await complete([
        {
          role: "user",
          content: `You are a Go-To-Market strategy expert. Create a detailed GTM strategy for:

Company: ${company_name}
Product: ${product_desc ?? "SaaS Product"}
Target Market: ${target_market ?? "SMBs"}
Marketing Budget: ${budget_range ?? "Bootstrap/$0-$5k/mo"}
Launch Timeframe: ${timeframe ?? "90 days"}

Provide:
1. Target customer persona (3 key characteristics)
2. Primary acquisition channels (rank by ROI potential)
3. 30/60/90 day action plan with specific milestones
4. Pricing strategy recommendation
5. Key success metrics to track

Keep actionable and specific.`
        }
      ], { maxTokens: 2048 });

      return NextResponse.json({ gtm_strategy: gtm });
    }

    // ── Burn Rate Calculator ──────────────────────────────────────────────────
    if (action === "burn_analysis") {
      const { monthly_burn, cash_on_hand, monthly_revenue, growth_rate } = body;
      if (!monthly_burn || !cash_on_hand) {
        return NextResponse.json({ error: "monthly_burn and cash_on_hand required" }, { status: 400 });
      }

      const net_burn = (monthly_burn as number) - (monthly_revenue ?? 0 as number);
      const runway_months = net_burn > 0 ? Math.floor((cash_on_hand as number) / net_burn) : 999;

      const analysis = await complete([
        {
          role: "user",
          content: `You are a startup financial advisor. Analyze this startup's financial position:

Monthly Burn Rate: $${monthly_burn}
Monthly Revenue: $${monthly_revenue ?? 0}
Net Monthly Burn: $${net_burn}
Cash on Hand: $${cash_on_hand}
Calculated Runway: ${runway_months === 999 ? "Default Positive" : runway_months + " months"}
Revenue Growth Rate: ${growth_rate ?? 0}%/month

Provide:
1. Runway health assessment (Critical/Concerning/Healthy/Excellent)
2. 3 specific cost-cutting recommendations if needed
3. Revenue acceleration opportunities
4. Fundraising timing recommendation
5. Key financial KPIs to track monthly

Be direct and actionable.`
        }
      ]);

      return NextResponse.json({
        metrics: {
          monthly_burn,
          monthly_revenue: monthly_revenue ?? 0,
          net_burn,
          cash_on_hand,
          runway_months: runway_months === 999 ? "∞" : runway_months,
        },
        analysis
      });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err: unknown) {
    const notConfigured = llmNotConfiguredResponse(err);
    if (notConfigured) return notConfigured;
    console.error("[domains/business] POST error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
