import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { query } from "@/lib/dsql";
import { randomUUID } from "crypto";

export async function GET() {
  let scope;
  try { scope = await requireScope({ area: "crm", edit: false }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const userId = scope.dataId;

  const clients = await query(
    "SELECT * FROM agency_clients WHERE user_id = $1 ORDER BY created_at DESC",
    [userId]
  );
  return NextResponse.json({ clients });
}

export async function POST(req: Request) {
  let scope;
  try { scope = await requireScope({ area: "crm", edit: true }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const userId = scope.dataId;

  const rawBody = await req.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const body = rawBody;
  const { company_name, contact_person, email, industry, website, total_spend = 0 } = body;

  if (!company_name) {
    return NextResponse.json({ error: "Company name is required" }, { status: 400 });
  }

  const id = randomUUID();
  const [client] = await query(
    `INSERT INTO agency_clients
       (id, user_id, company_name, contact_person, email, industry, website, total_spend, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
     RETURNING *`,
    [id, userId, company_name, contact_person ?? null, email ?? null, industry ?? null, website ?? null, total_spend]
  );

  return NextResponse.json({ client });
}

export async function PATCH(req: Request) {
  let scope;
  try { scope = await requireScope({ area: "crm", edit: true }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const userId = scope.dataId;

  const rawBody = await req.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const body = rawBody;
  const { id, ...updates } = body;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const allowed = ["company_name", "contact_person", "email", "industry", "website", "total_spend", "status"];
  const fields = Object.keys(updates).filter(k => allowed.includes(k));
  if (fields.length === 0) return NextResponse.json({ error: "No valid fields" }, { status: 400 });

  const setClauses = fields.map((f, i) => `${f} = $${i + 3}`).join(", ");
  const updatesMap = updates as Record<string, unknown>;
  const values = [userId, id, ...fields.map(f => updatesMap[f])];

  const [client] = await query(
    `UPDATE agency_clients SET ${setClauses}, updated_at = NOW() WHERE user_id = $1 AND id = $2 RETURNING *`,
    values
  );

  return NextResponse.json({ client });
}
