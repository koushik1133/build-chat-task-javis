import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { queryOne } from "@/lib/dsql";
import { enrichLead } from "@/lib/lead-enrichment";
import { emitEvent } from "@/lib/events/bus";
import { readCappedText, sanitiseLeadPayload, rateLimit } from "@/lib/request-limits";
import { corsHeadersFor, corsPreflight, siteAllowedOrigins } from "@/lib/cors";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ siteId: string }> };
const CORS = { methods: "GET, POST, OPTIONS", headers: "Content-Type" };

async function corsFor(req: Request, siteId: string) {
  const allowedOrigins = z.string().uuid().safeParse(siteId).success ? await siteAllowedOrigins(siteId) : [];
  return { allowedOrigins, ...CORS };
}

function withCors(res: NextResponse, headers: Record<string, string>) {
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}

export async function OPTIONS(req: NextRequest, { params }: Ctx) {
  const { siteId } = await params;
  return corsPreflight(req, await corsFor(req, siteId));
}

export async function GET(req: NextRequest, { params }: Ctx) {
  const { siteId } = await params;
  const cors = corsHeadersFor(req, await corsFor(req, siteId));
  return withCors(NextResponse.json({ status: "ok" }, { status: 200 }), cors);
}

/** Public lead capture for the embeddable chat widget. */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { siteId } = await params;
  const cors = corsHeadersFor(req, await corsFor(req, siteId));
  const corsResponse = (res: NextResponse) => withCors(res, cors);
  try {

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

    void emitEvent(site.user_id, { type: "lead.captured", entity: "site_lead", entityId: leadId, data: { siteId, source: "widget" } });

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
