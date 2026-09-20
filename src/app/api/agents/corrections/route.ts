import { NextRequest, NextResponse } from "next/server";
import { query, queryOne } from "@/lib/dsql";
import { createClient } from "@/lib/supabase/server";

export async function GET(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const agentId = searchParams.get('agentId');

    let sql = `SELECT id, agent_id, original_text, corrected_text, context, created_at FROM agent_corrections WHERE user_id = $1`;
    const params = [user.id];

    if (agentId) {
      sql += ` AND agent_id = $2`;
      params.push(agentId);
    }
    
    sql += ` ORDER BY created_at DESC LIMIT 50`;

    const corrections = await query(sql, params);
    return NextResponse.json({ corrections }, { status: 200 });
  } catch (err) {
    console.error("Get Corrections Error:", err);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rawBody = await req.json().catch(() => null);
    if (!rawBody || typeof rawBody !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    const { agentId, originalText, correctedText, context } = rawBody;

    if (!agentId || !originalText || !correctedText) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const id = crypto.randomUUID();
    const result = await queryOne<{ id: string }>(
      `INSERT INTO agent_corrections (id, user_id, agent_id, original_text, corrected_text, context, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING id`,
      [id, user.id, agentId, originalText, correctedText, context || ""]
    );

    return NextResponse.json({ success: true, id: result?.id }, { status: 200 });
  } catch (err) {
    console.error("Create Correction Error:", err);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
