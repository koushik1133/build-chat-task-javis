import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { enrichLead } from "@/lib/lead-enrichment";

export const runtime = "nodejs";

/**
 * Enrich a captured lead for the signed-in user.
 * The lead owner is always the session user — never a client-supplied id.
 */
export async function POST(req: Request) {
  let scope;
  try {
    scope = await requireScope({ area: "leads", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const leadId =
    body && typeof body === "object" && typeof (body as { leadId?: unknown }).leadId === "string"
      ? (body as { leadId: string }).leadId
      : null;
  if (!leadId) {
    return NextResponse.json({ error: "Missing leadId" }, { status: 400 });
  }

  try {
    const result = await enrichLead(leadId, scope.dataId);
    if (!result) {
      return NextResponse.json({ error: "Lead not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true, ...result }, { status: 200 });
  } catch (err) {
    console.error("Enrichment Error:", err);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
