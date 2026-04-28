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
    
    if (!z.string().uuid().safeParse(siteId).success) {
      return NextResponse.json({ error: "Invalid site ID" }, { status: 400, headers: corsHeaders });
    }

    const { path } = await req.json();
    const userAgent = req.headers.get("user-agent") || "Unknown";

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      return NextResponse.json({ error: "Server error" }, { status: 500, headers: corsHeaders });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    const { error: insertErr } = await supabaseAdmin
      .from("site_analytics")
      .insert({
        site_id: siteId,
        path: path || "/",
        user_agent: userAgent,
      });

    if (insertErr) {
      return NextResponse.json({ error: "Failed to record analytics" }, { status: 500, headers: corsHeaders });
    }

    return NextResponse.json({ success: true }, { status: 200, headers: corsHeaders });
  } catch {
    return NextResponse.json(
      { error: "Bad request" },
      { status: 400, headers: corsHeaders }
    );
  }
}
