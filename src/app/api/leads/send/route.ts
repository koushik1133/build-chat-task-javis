import { NextRequest, NextResponse } from "next/server";
import { query, queryOne } from "@/lib/dsql";
import { sendEmailUnified } from "@/lib/email-sender";
import { createClient } from "@/lib/supabase/server";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function wrapHtml(text: string) {
  return '<div style="font-family:sans-serif;line-height:1.6">' + text.replace(/\\n/g, '<br>') + '</div>';
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { leadId, subject, body } = await req.json();

    if (!leadId) {
      return NextResponse.json({ error: "Missing leadId" }, { status: 400 });
    }

    const lead = await queryOne<{ data: string; draft_email_subject: string; draft_email_body: string }>(
      `SELECT data, draft_email_subject, draft_email_body FROM site_leads WHERE id = $1 AND user_id = $2`,
      [leadId, user.id]
    );

    if (!lead) {
      return NextResponse.json({ error: "Lead not found" }, { status: 404 });
    }

    let leadData: { email?: unknown };
    try {
      leadData = JSON.parse(lead.data);
    } catch {
      return NextResponse.json({ error: "Lead data is corrupted" }, { status: 422 });
    }

    const leadEmail = leadData?.email;
    if (typeof leadEmail !== "string" || !EMAIL_RE.test(leadEmail)) {
      return NextResponse.json({ error: "Lead has no valid email address" }, { status: 400 });
    }

    const finalSubject = subject || lead.draft_email_subject;
    const finalBody = body || lead.draft_email_body;

    const result = await sendEmailUnified({
      to: leadEmail,
      subject: finalSubject,
      html: wrapHtml(finalBody)
    });

    if (result.success) {
      await query(
        `UPDATE site_leads SET status = 'sent', sent_at = NOW() WHERE id = $1 AND user_id = $2`,
        [leadId, user.id]
      );
      return NextResponse.json({ success: true, message: "Email sent" }, { status: 200 });
    } else {
      return NextResponse.json({ error: result.message, detail: result.detail }, { status: 500 });
    }
  } catch (err) {
    console.error("Send Email Error:", err);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
