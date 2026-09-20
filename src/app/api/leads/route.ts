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

    const leads = await query(
      `SELECT id, site_id, data, status, research_summary, draft_email_subject, draft_email_body, created_at, sent_at, enriched_at 
       FROM site_leads 
       WHERE user_id = $1 
       ORDER BY created_at DESC`,
      [user.id]
    );

    return NextResponse.json({ leads }, { status: 200 });
  } catch (err) {
    console.error("Get Leads Error:", err);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
