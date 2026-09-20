import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { query } from '@/lib/dsql';
import { complete } from '@/lib/llm';
import { llmNotConfiguredResponse } from '@/lib/llm-response';
import { parseModelJson } from '@/lib/model-json';

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const rawBody = await req.json().catch(() => null);
    if (!rawBody || typeof rawBody !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    const body = rawBody;
    const { action, ...payload } = body as Record<string, unknown> & { action?: string };
    const text = (v: unknown, max = 8000) => (typeof v === "string" ? v.slice(0, max) : "");
    const unreadable = () =>
      NextResponse.json({ error: "The model returned an unreadable response. Please try again." }, { status: 502 });

    switch (action) {
      case 'add_portfolio_item': {
        const { name, asset_type, ticker, quantity, buy_price, current_price, notes } = payload;
        

        const result = await query(`
          INSERT INTO finance_portfolios (id, user_id, name, asset_type, ticker, quantity, buy_price, current_price, notes)
          VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING *
        `, [user.id, name, asset_type, ticker || null, quantity, buy_price, current_price, notes || null]);

        return NextResponse.json({ item: result[0] });
      }
      case 'analyze_portfolio': {
        const items = await query('SELECT * FROM finance_portfolios WHERE user_id = $1', [user.id]);
        
        const prompt = `Analyze this financial portfolio and provide a diversification analysis, a risk score from 0 to 100, and a list of recommendations.
        Portfolio: ${JSON.stringify(items)}
        Respond strictly in JSON format with this structure:
        {
          "analysis": "string detailing diversification and health",
          "risk_score": number,
          "recommendations": ["string", "string"]
        }`;

        const aiResponse = await complete([{ role: "user", content: prompt }]);
        const parsed = parseModelJson(aiResponse);
        if (!parsed) return unreadable();
        return NextResponse.json(parsed);
      }
      case 'generate_financial_report': {
        const { period, revenue, expenses } = payload;
        const notes = text(payload.notes);
        const prompt = `Generate a structured P&L narrative with KPI commentary for the following data.
        Period: ${period}
        Revenue: $${revenue}
        Expenses: $${expenses}
        Notes: ${notes || 'None'}
        Provide the report as a narrative text.`;
        
        const report = await complete([{ role: 'user', content: prompt }]);
        return NextResponse.json({ report });
      }
      case 'risk_assessment': {
        const description = text(payload.description);
        const market_context = text(payload.market_context);
        const prompt = `Assess the financial risk for the following scenario:
        Description: ${description}
        Market Context: ${market_context || 'None'}
        
        Provide the assessment strictly in JSON format with this structure:
        {
          "risk_level": "Low" | "Medium" | "High",
          "score": number, // 0-100
          "mitigations": ["string", "string"]
        }`;
        
        const aiResponse = await complete([{ role: 'user', content: prompt }]);
        const parsed = parseModelJson(aiResponse);
        if (!parsed) return unreadable();
        return NextResponse.json(parsed);
      }
      case 'budget_forecast': {
        const { monthly_revenue, fixed_costs, variable_costs, growth_rate } = payload;
        const prompt = `Project a 12-month financial forecast given these starting monthly values:
        Monthly Revenue: $${monthly_revenue}
        Fixed Costs: $${fixed_costs}
        Variable Costs: $${variable_costs}
        Monthly Growth Rate (%): ${growth_rate}
        
        Respond strictly in JSON format with this structure:
        {
          "forecast": [
            { "month": "Month 1", "revenue": number, "expenses": number, "profit": number },
            ... for 12 months
          ]
        }`;

        const aiResponse = await complete([{ role: 'user', content: prompt }]);
        const parsed = parseModelJson(aiResponse);
        if (!parsed) return unreadable();
        return NextResponse.json(parsed);
      }
      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (err) {
    const notConfigured = llmNotConfiguredResponse(err);
    if (notConfigured) return notConfigured;
    console.error("[domains/finance] POST error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action');

  if (action === 'portfolio') {
    try {
      const items = await query('SELECT * FROM finance_portfolios WHERE user_id = $1 ORDER BY created_at DESC', [user.id]);
      return NextResponse.json({ items });
    } catch (err) {
      console.error("[domains/finance] GET error:", err);
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
  }

  return NextResponse.json({ error: 'Invalid GET action' }, { status: 400 });
}
