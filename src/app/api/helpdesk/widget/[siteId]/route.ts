import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { queryOne } from "@/lib/dsql";
import { createTicket, formatTicketNumber } from "@/lib/helpdesk/tickets";
import { WidgetTicketSchema } from "@/lib/helpdesk/http";
import { clientIp, rateLimitAsync, readCappedText } from "@/lib/request-limits";
import { corsHeadersFor, corsPreflight, siteAllowedOrigins } from "@/lib/cors";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ siteId: string }> };
const CORS = { methods: "POST, OPTIONS", headers: "Content-Type" };

async function corsFor(siteId: string) {
  const allowedOrigins = z.string().uuid().safeParse(siteId).success ? await siteAllowedOrigins(siteId) : [];
  return { allowedOrigins, ...CORS };
}

function withCors(res: NextResponse, headers: Record<string, string>) {
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}

export async function OPTIONS(req: NextRequest, { params }: Ctx) {
  const { siteId } = await params;
  return corsPreflight(req, await corsFor(siteId));
}

/**
 * POST /api/helpdesk/widget/[siteId] — { name, email, subject, body }
 * Anonymous ticket capture for the embeddable support widget. The site owns
 * the ticket (user_id = sites.user_id). Rate-limited per IP and per site.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { siteId } = await params;
  const cors = corsHeadersFor(req, await corsFor(siteId));
  const reply = (res: NextResponse) => withCors(res, cors);
  try {
    if (!z.string().uuid().safeParse(siteId).success) {
      return reply(NextResponse.json({ error: "Invalid site ID format" }, { status: 400 }));
    }
    const ip = clientIp(req);
    if (!(await rateLimitAsync(`helpdesk-widget:ip:${ip}`, 10, 60 * 60 * 1000)).allowed || !(await rateLimitAsync(`helpdesk-widget:site:${siteId}`, 120, 60 * 60 * 1000)).allowed) {
      return reply(NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "3600" } }));
    }

    const raw = await readCappedText(req, 32_000);
    if (raw === null) return reply(NextResponse.json({ error: "Payload too large" }, { status: 413 }));
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return reply(NextResponse.json({ error: "Invalid JSON" }, { status: 400 }));
    }
    const parsed = WidgetTicketSchema.safeParse(json);
    if (!parsed.success) return reply(NextResponse.json({ error: "Invalid payload", detail: parsed.error.flatten() }, { status: 400 }));

    const site = await queryOne<{ user_id: string }>(`SELECT user_id FROM sites WHERE id = $1`, [siteId]);
    if (!site) return reply(NextResponse.json({ error: "Site not found" }, { status: 404 }));

    const contact = await queryOne<{ id: string }>(
      `SELECT id FROM crm_contacts WHERE user_id = $1 AND LOWER(email) = LOWER($2) LIMIT 1`,
      [site.user_id, parsed.data.email]
    ).catch(() => null);

    const ticket = await createTicket(site.user_id, {
      subject: parsed.data.subject,
      body: parsed.data.body,
      source: "widget",
      requester_email: parsed.data.email,
      requester_name: parsed.data.name,
      contact_id: contact?.id ?? null,
      tags: ["widget"],
      author_kind: "customer",
    });

    return reply(
      NextResponse.json({ success: true, ticket: { id: ticket.id, number: formatTicketNumber(ticket.number), status: ticket.status } }, { status: 201 })
    );
  } catch (err) {
    console.error("[helpdesk] widget POST failed:", err);
    return reply(NextResponse.json({ error: "Internal Server Error" }, { status: 500 }));
  }
}
