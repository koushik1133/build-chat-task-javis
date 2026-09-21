import { NextRequest, NextResponse } from "next/server";
import { query, queryOne } from "@/lib/dsql";
import { sendEmailUnified } from "@/lib/email-sender";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function wrapHtml(text: string) {
  return '<div style="font-family:sans-serif;line-height:1.6">' + text.replace(/\\n/g, '<br>') + '</div>';
}

export async function POST(req: NextRequest) {
  try {
    let scope;
    try {
      scope = await requireScope({ area: "leads", edit: true });
    } catch (err) {
      return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const { leadId, subject, body } = await req.json();

    if (!leadId) {
      return NextResponse.json({ error: "Missing leadId" }, { status: 400 });
    }

    const lead = await queryOne<{ data: string; draft_email_subject: string; draft_email_body: string }>(
      `SELECT data, draft_email_subject, draft_email_body FROM site_leads WHERE id = $1 AND user_id = $2`,
      [leadId, scope.dataId]
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
        [leadId, scope.dataId]
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
