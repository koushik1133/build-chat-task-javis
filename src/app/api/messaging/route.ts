import { NextResponse } from "next/server";
import { query } from "@/lib/dsql";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const conversations = await query(
      `SELECT id, channel, from_number, messages, updated_at 
       FROM messaging_conversations 
       WHERE user_id = $1 
       ORDER BY updated_at DESC`,
      [user.id]
    );

    return NextResponse.json({ conversations }, { status: 200 });
  } catch (err) {
    console.error("Get Messaging Conversations Error:", err);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
