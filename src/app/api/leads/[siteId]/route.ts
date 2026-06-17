import { NextResponse } from "next/server";
import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";

export const runtime = "nodejs";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return NextResponse.json({}, { status: 200, headers: corsHeaders });
}

/**
 * Public lead-capture endpoint — called by contact forms inside generated sites.
 * Stores form data as JSON text in Aurora DSQL site_leads table.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ siteId: string }> }
) {
  try {
    const { siteId } = await params;

    if (!z.string().uuid().safeParse(siteId).success) {
      return NextResponse.json(
        { error: "Invalid site ID format" },
        { status: 400, headers: corsHeaders }
      );
    }

    const data = await req.json();

    // Application-layer integrity check — verify site exists
    const site = await queryOne("SELECT id FROM sites WHERE id = $1", [siteId]);
    if (!site) {
      return NextResponse.json({ error: "Site not found" }, { status: 404, headers: corsHeaders });
    }

    // data is stored as TEXT in DSQL (JSON.stringify)
    await query(
      "INSERT INTO site_leads (site_id, data) VALUES ($1, $2)",
      [siteId, JSON.stringify(data)]
    );

    return NextResponse.json({ success: true }, { status: 200, headers: corsHeaders });
  } catch {
    return NextResponse.json(
      { error: "Bad request" },
      { status: 400, headers: corsHeaders }
    );
  }
}
