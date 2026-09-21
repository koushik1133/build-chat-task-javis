import { NextResponse } from "next/server";
import { query } from "@/lib/dsql";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";

export async function GET() {
  try {
    let scope;
    try {
      scope = await requireScope({ area: "leads", edit: false });
    } catch (err) {
      return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const leads = await query(
      `SELECT id, site_id, data, status, research_summary, draft_email_subject, draft_email_body, created_at, sent_at, enriched_at 
       FROM site_leads 
       WHERE user_id = $1 
       ORDER BY created_at DESC`,
      [scope.dataId]
    );

    return NextResponse.json({ leads }, { status: 200 });
  } catch (err) {
    console.error("Get Leads Error:", err);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
