import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { query, queryOne } from "@/lib/dsql";
import { randomUUID } from "crypto";

export async function GET() {
  let scope;
  try { scope = await requireScope({ area: "social", edit: false }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const userId = scope.dataId;

  const brands = await query(
    "SELECT * FROM social_brands WHERE user_id = $1 ORDER BY created_at DESC",
    [userId]
  );

  // Auto-populate from business_profile if no brand exists
  if (brands.length === 0) {
    const profile = await queryOne(
      "SELECT * FROM business_profile WHERE user_id = $1",
      [userId]
    );
    if (profile) {
      return NextResponse.json({ brands: [], profile });
    }
  }

  return NextResponse.json({ brands });
}

export async function POST(req: Request) {
  let scope;
  try { scope = await requireScope({ area: "social", edit: true }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const userId = scope.dataId;

  const rawBody = await req.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const body = rawBody;
  const {
    name,
    website,
    industry,
    products,
    tone = "professional",
    brand_colors,
    target_audience,
    posting_frequency = "daily",
  } = body;

  if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });

  const id = randomUUID();
  const [brand] = await query(
    `INSERT INTO social_brands
       (id, user_id, name, website, industry, products, tone, brand_colors, target_audience, posting_frequency)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [id, userId, name, website, industry, products, tone, brand_colors, target_audience, posting_frequency]
  );

  return NextResponse.json({ brand });
}

export async function PATCH(req: Request) {
  let scope;
  try { scope = await requireScope({ area: "social", edit: true }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const userId = scope.dataId;

  const rawBody = await req.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const body = rawBody;
  const { id, ...updates } = body;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const fields = Object.keys(updates)
    .filter(k => ["name","website","industry","products","tone","brand_colors","target_audience","posting_frequency"].includes(k));
  if (fields.length === 0) return NextResponse.json({ error: "No valid fields" }, { status: 400 });

  const setClauses = fields.map((f, i) => `${f} = $${i + 3}`).join(", ");
  const updatesMap = updates as Record<string, unknown>;
  const values = [userId, id, ...fields.map(f => updatesMap[f])];

  const [brand] = await query(
    `UPDATE social_brands SET ${setClauses}, updated_at = NOW() WHERE user_id = $1 AND id = $2 RETURNING *`,
    values
  );

  return NextResponse.json({ brand });
}
