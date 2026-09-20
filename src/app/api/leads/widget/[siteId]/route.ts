import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { queryOne } from "@/lib/dsql";
import { enrichLead } from "@/lib/lead-enrichment";
import { readCappedText, sanitiseLeadPayload, rateLimit } from "@/lib/request-limits";

export const runtime = "nodejs";

function corsResponse(res: NextResponse) {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return res;
}

export async function OPTIONS() {
  return corsResponse(NextResponse.json({}, { status: 200 }));
}

export async function GET() {
  return corsResponse(NextResponse.json({ status: "ok" }, { status: 200 }));
}

/** Public lead capture for the embeddable chat widget. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ siteId: string }> }
) {
  try {
    const { siteId } = await params;

    if (!z.string().uuid().safeParse(siteId).success) {
      return corsResponse(NextResponse.json({ error: "Invalid site ID format" }, { status: 400 }));
    }

    const raw = await readCappedText(req);
    if (raw === null) {
      return corsResponse(NextResponse.json({ error: "Payload too large" }, { status: 413 }));
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return corsResponse(NextResponse.json({ error: "Invalid JSON" }, { status: 400 }));
    }

    const data = sanitiseLeadPayload(parsed);
    if (!data) {
      return corsResponse(NextResponse.json({ error: "Invalid payload" }, { status: 400 }));
    }

    // 1. Fetch the site to get user_id
    const site = await queryOne<{ user_id: string }>(
      `SELECT user_id FROM sites WHERE id = $1`,
      [siteId]
    );

    if (!site) {
      return corsResponse(NextResponse.json({ error: "Site not found" }, { status: 404 }));
    }

    // 2. Insert into site_leads
    const leadId = crypto.randomUUID();
    await queryOne(
      `INSERT INTO site_leads (id, site_id, user_id, data, status, created_at)
       VALUES ($1, $2, $3, $4, 'new', NOW())
       RETURNING id`,
      [leadId, siteId, site.user_id, JSON.stringify(data)]
    );

    // 3. Auto-enrich in-process (fire-and-forget). The lead is always stored;
    //    only the LLM enrichment is throttled per site.
    if (rateLimit(`enrich:${siteId}`, 20, 60 * 60 * 1000).allowed) {
      void enrichLead(leadId, site.user_id).catch((err) =>
        console.error("Auto-enrichment failed:", err)
      );
    }

    return corsResponse(NextResponse.json({ success: true, message: "Lead captured" }, { status: 200 }));
  } catch (err: unknown) {
    console.error("Widget POST Error:", err);
    return corsResponse(NextResponse.json({ error: "Internal Server Error" }, { status: 500 }));
  }
}
