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
      case 'add_product': {
        const { name, category, sku, price, stock_count, stock_threshold } = payload;
        

        const result = await query(
          `INSERT INTO ecommerce_products (user_id, name, category, sku, price, stock_count, stock_threshold) 
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [user.id, name, category, sku, price, stock_count, stock_threshold]
        );
        return NextResponse.json({ product: result[0] });
      }

      case 'generate_description': {
        const { product_name, target_audience, tone } = payload;
        const features = text(payload.features);
        const prompt = `Write an SEO-optimized product description for the following product:
        Product Name: ${product_name}
        Features: ${features}
        Target Audience: ${target_audience}
        Tone: ${tone || 'Professional'}
        Provide the main description and 3 variations. Return ONLY a JSON object with keys: description (string), variations (array of 3 strings).`;

        const response = await complete([{ role: 'user', content: prompt }]);
        const parsed = parseModelJson(response);
        if (!parsed) return NextResponse.json({ description: response, variations: [] });
        return NextResponse.json(parsed);
      }

      case 'analyze_reviews': {
        const { product_name } = payload;
        const reviews_text = text(payload.reviews_text);
        const prompt = `Analyze the following customer reviews for the product "${product_name}":
        Reviews: ${reviews_text}
        
        Return ONLY a JSON object with keys: sentiment (string), rating_out_of_5 (number), top_praise (string), top_complaints (string), improvements (string).`;

        const response = await complete([{ role: 'user', content: prompt }]);
        const parsed = parseModelJson(response);
        if (!parsed) return NextResponse.json({ sentiment: "N/A", rating_out_of_5: 0, top_praise: "N/A", top_complaints: "N/A", improvements: response });
        return NextResponse.json(parsed);
      }

      case 'generate_ad_copy': {
        const { product_name, platform } = payload;
        const usp = text(payload.usp);
        const prompt = `Generate ad copy for ${platform}.
        Product: ${product_name}
        Unique Selling Proposition: ${usp}
        
        Return ONLY a JSON object with keys: ad_copy (string), headline (string), cta (string).`;

        const response = await complete([{ role: 'user', content: prompt }]);
        const parsed = parseModelJson(response);
        if (!parsed) return NextResponse.json({ ad_copy: response, headline: "N/A", cta: "N/A" });
        return NextResponse.json(parsed);
      }

      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (err) {
    const notConfigured = llmNotConfiguredResponse(err);
    if (notConfigured) return notConfigured;
    console.error("[domains/ecommerce] POST error:", err);
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

    if (action === 'products') {
      try {
        const products = await query(
          'SELECT * FROM ecommerce_products WHERE user_id = $1 ORDER BY created_at DESC',
          [user.id]
        );
        const mappedProducts = products.map((p) => ({
          ...p,
          low_stock: Number(p.stock_count) <= Number(p.stock_threshold)
        }));
        return NextResponse.json({ products: mappedProducts });
      } catch (e) {
        console.error("[domains/ecommerce] products query failed:", e);
        return NextResponse.json({ products: [] });
      }
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (err) {
    console.error("[domains/ecommerce] GET error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
