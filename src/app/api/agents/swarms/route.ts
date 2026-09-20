import { NextRequest, NextResponse } from "next/server";
import { query, queryOne } from "@/lib/dsql";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const swarms = await query(
      `SELECT id, name, description, nodes, created_at FROM agent_swarms WHERE user_id = $1 ORDER BY created_at DESC`,
      [user.id]
    );

    return NextResponse.json({ swarms }, { status: 200 });
  } catch (err) {
    console.error("Get Swarms Error:", err);
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
    const { id: existingId, name, description, nodes } = rawBody;

    if (!name || !nodes) {
      return NextResponse.json({ error: "Missing name or nodes" }, { status: 400 });
    }

    let result = null;
    if (existingId) {
      result = await queryOne(
        `UPDATE agent_swarms 
         SET name = $1, description = $2, nodes = $3, updated_at = NOW() 
         WHERE id = $4 AND user_id = $5 
         RETURNING id, name, description, nodes, created_at`,
        [name, description || "", JSON.stringify(nodes), existingId, user.id]
      );
    }

    if (!result) {
      const id = existingId || crypto.randomUUID();
      result = await queryOne(
        `INSERT INTO agent_swarms (id, user_id, name, description, nodes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
         RETURNING id, name, description, nodes, created_at`,
        [id, user.id, name, description || "", JSON.stringify(nodes)]
      );
    }

    return NextResponse.json({ swarm: result }, { status: 200 });
  } catch (err) {
    console.error("Create/Update Swarm Error:", err);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rawBody = await req.json().catch(() => null);
    if (!rawBody || typeof rawBody !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    const { id } = rawBody;
    if (!id) {
      return NextResponse.json({ error: "Missing id" }, { status: 400 });
    }

    await query("DELETE FROM agent_swarms WHERE id = $1 AND user_id = $2", [id, user.id]);
    return NextResponse.json({ success: true }, { status: 200 });
  } catch (err) {
    console.error("Delete Swarm Error:", err);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
