import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

export const runtime = "nodejs";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return NextResponse.json({}, { status: 200, headers: corsHeaders });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ siteId: string }> }
) {
  try {
    const { siteId } = await params;
    
    // Validate siteId is a valid UUID
    if (!z.string().uuid().safeParse(siteId).success) {
      return NextResponse.json({ error: "Invalid site ID format" }, { status: 400, headers: corsHeaders });
    }

    const data = await req.json();

    // Use the Service Role Key to bypass RLS, because this is an unauthenticated submission
    // and we didn't open anonymous inserts to the public table (to prevent spam directly to DB).
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      return NextResponse.json(
        { error: "Server configuration error" },
        { status: 500, headers: corsHeaders }
      );
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // Verify site exists first
    const { data: site, error: siteErr } = await supabaseAdmin
      .from("sites")
      .select("id, user_id, title")
      .eq("id", siteId)
      .single();

    if (siteErr || !site) {
      return NextResponse.json({ error: "Site not found" }, { status: 404, headers: corsHeaders });
    }

    // Insert lead
    const { error: insertErr } = await supabaseAdmin
      .from("site_leads")
      .insert({
        site_id: siteId,
        data,
      });

    if (insertErr) {
      return NextResponse.json({ error: "Failed to save lead" }, { status: 500, headers: corsHeaders });
    }

    // Try sending email notification via Resend
    const resendKey = process.env.RESEND_API_KEY;
    const resendFrom = process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev";
    if (resendKey) {
      try {
        const { data: userData } = await supabaseAdmin.auth.admin.getUserById(site.user_id);
        const email = userData?.user?.email;
        if (email) {
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${resendKey}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              from: resendFrom,
              to: [email],
              subject: `New Lead for your site: ${site.title || siteId}`,
              html: `<p>You have received a new lead!</p><pre>${JSON.stringify(data, null, 2)}</pre>`
            })
          });
        }
      } catch (e) {
        console.error("Failed to send email notification", e);
      }
    }

    return NextResponse.json({ success: true }, { status: 200, headers: corsHeaders });
  } catch {
    return NextResponse.json(
      { error: "Bad request" },
      { status: 400, headers: corsHeaders }
    );
  }
}
