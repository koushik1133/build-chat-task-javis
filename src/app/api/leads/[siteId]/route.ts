import { NextResponse } from "next/server";
import { z } from "zod";
import { queryOne } from "@/lib/dsql";
import { enrichLead } from "@/lib/lead-enrichment";
import { emitEvent } from "@/lib/events/bus";
import { readCappedText, sanitiseLeadPayload, rateLimit } from "@/lib/request-limits";

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

    const raw = await readCappedText(req);
    if (raw === null) {
      return NextResponse.json({ error: "Payload too large" }, { status: 413, headers: corsHeaders });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers: corsHeaders });
    }

    const data = sanitiseLeadPayload(parsed);
    if (!data) {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400, headers: corsHeaders });
    }

    // Application-layer integrity check — verify site exists
    const site = await queryOne<{ id: string; user_id: string }>("SELECT id, user_id FROM sites WHERE id = $1", [siteId]);
    if (!site) {
      return NextResponse.json({ error: "Site not found" }, { status: 404, headers: corsHeaders });
    }

    // data is stored as TEXT in DSQL (JSON.stringify)
    const result = await queryOne<{ id: string }>(
      "INSERT INTO site_leads (site_id, user_id, data) VALUES ($1, $2, $3) RETURNING id",
      [siteId, site.user_id, JSON.stringify(data)]
    );

    if (result?.id) void emitEvent(site.user_id, { type: "lead.captured", entity: "site_lead", entityId: result.id, data: { siteId } });

    // Auto-enrich in-process (fire-and-forget). The lead is always stored;
    // only the LLM enrichment is throttled per site.
    if (result?.id && rateLimit(`enrich:${siteId}`, 20, 60 * 60 * 1000).allowed) {
      void enrichLead(result.id, site.user_id).catch((err) =>
        console.error("Auto-enrichment failed:", err)
      );
    }

    return NextResponse.json({ success: true }, { status: 200, headers: corsHeaders });
  } catch (err) {
    console.error("Widget Lead POST error:", err);
    return NextResponse.json(
      { error: "Bad request" },
      { status: 400, headers: corsHeaders }
    );
  }
}
