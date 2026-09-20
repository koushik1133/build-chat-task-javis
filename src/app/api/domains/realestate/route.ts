import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { query } from '@/lib/dsql';
import { complete } from '@/lib/llm';
import { llmNotConfiguredResponse } from '@/lib/llm-response';
import { parseModelJson } from '@/lib/model-json';

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
      case 'add_property': {
        const { address, city, state, property_type, price, bedrooms, bathrooms, sqft, status } = payload;
        

        const result = await query(
          `INSERT INTO realestate_properties (user_id, address, city, state, property_type, price, bedrooms, bathrooms, sqft, status) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
          [user.id, address, city, state, property_type, price, bedrooms, bathrooms, sqft, status]
        );
        return NextResponse.json({ property: result[0] });
      }

      case 'generate_listing': {
        const { address, bedrooms, bathrooms, sqft, price, neighborhood } = payload;
        const features = text(payload.features);
        const prompt = `Write a compelling real estate property listing description for the following property:
        Address: ${address}
        Bedrooms: ${bedrooms}
        Bathrooms: ${bathrooms}
        Square Footage: ${sqft} sqft
        Price: $${price}
        Neighborhood: ${neighborhood}
        Features: ${features}
        Make it engaging, persuasive, and highlight the key selling points.`;

        const listing_text = await complete([{ role: 'user', content: prompt }]);
        return NextResponse.json({ listing_text });
      }

      case 'market_analysis': {
        const { city, state, property_type, price_range } = payload;
        const prompt = `Generate a real estate market analysis report for:
        Location: ${city}, ${state}
        Property Type: ${property_type}
        Price Range: ${price_range}
        Include trends, supply/demand factors, and future outlook.`;

        const analysis = await complete([{ role: 'user', content: prompt }]);
        return NextResponse.json({ analysis });
      }

      case 'investment_analysis': {
        const { purchase_price, monthly_rent, expenses, financing_rate } = payload;
        const prompt = `Perform a real estate investment analysis for a property with:
        Purchase Price: $${purchase_price}
        Monthly Rent: $${monthly_rent}
        Monthly Expenses: $${expenses}
        Financing Rate: ${financing_rate}%
        Calculate the approximate ROI, Cap Rate, and Monthly Cash Flow. Provide a recommendation to BUY, HOLD, or SELL with a brief explanation. Return the result in a structured JSON format with exactly keys: roi, cap_rate, monthly_cashflow, recommendation`;

        const response = await complete([{ role: 'user', content: prompt }]);
        
        const parsePrompt = `Extract the following JSON from this text, returning ONLY the JSON object with keys: roi, cap_rate, monthly_cashflow, recommendation. Text: ${response}`;
        const jsonText = await complete([{ role: 'user', content: parsePrompt }]);
        
        const parsed = parseModelJson(jsonText);
        if (!parsed) return NextResponse.json({ roi: "N/A", cap_rate: "N/A", monthly_cashflow: "N/A", recommendation: response });
        return NextResponse.json(parsed);
      }

      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (err) {
    const notConfigured = llmNotConfiguredResponse(err);
    if (notConfigured) return notConfigured;
    console.error("[domains/realestate] POST error:", err);
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

    if (action === 'properties') {
      try {
        const properties = await query(
          'SELECT * FROM realestate_properties WHERE user_id = $1 ORDER BY created_at DESC',
          [user.id]
        );
        return NextResponse.json({ properties });
      } catch (e) {
        console.error("[domains/realestate] properties query failed:", e);
        return NextResponse.json({ properties: [] });
      }
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (err) {
    console.error("[domains/realestate] GET error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
