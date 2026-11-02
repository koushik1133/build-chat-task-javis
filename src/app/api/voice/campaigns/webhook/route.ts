import { NextRequest, NextResponse } from "next/server";
import { handleGather, handleStatus, loadTargetWithCampaign, twimlForTarget, verifyCampaignSignature } from "@/lib/voice/dialer";
import { buildHangupTwiml } from "@/lib/voice/twiml";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function twiml(xml: string, status = 200): NextResponse {
  return new NextResponse(xml, { status, headers: { "Content-Type": "text/xml" } });
}

/**
 * Twilio callbacks for campaign calls: `kind=twiml` (call answered — read the
 * script), `kind=gather` (digit pressed) and `kind=status` (call lifecycle).
 * Every request must carry a valid X-Twilio-Signature for TWILIO_AUTH_TOKEN.
 */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  const params = new URLSearchParams(raw);
  if (!verifyCampaignSignature(req, params)) {
    return new NextResponse("Forbidden", { status: 403 });
  }
  const targetId = req.nextUrl.searchParams.get("target") ?? "";
  const kind = req.nextUrl.searchParams.get("kind") ?? "twiml";
  try {
    const t = targetId ? await loadTargetWithCampaign(targetId) : null;
    if (!t) return twiml(buildHangupTwiml("Sorry, this call is no longer active. Goodbye."));
    if (kind === "gather") return twiml(await handleGather(t, params));
    if (kind === "status") {
      await handleStatus(t, params);
      return new NextResponse(null, { status: 204 });
    }
    return twiml(await twimlForTarget(t, params));
  } catch (err) {
    console.error("[voice/webhook] failed:", err);
    return twiml(buildHangupTwiml("Sorry, something went wrong. Goodbye."));
  }
}

/** Twilio may GET the TwiML URL when Method is misconfigured; treat it the same but never without a signature. */
export async function GET(req: NextRequest) {
  if (!verifyCampaignSignature(req, new URLSearchParams())) {
    return new NextResponse("Forbidden", { status: 403 });
  }
  const targetId = req.nextUrl.searchParams.get("target") ?? "";
  const t = targetId ? await loadTargetWithCampaign(targetId).catch(() => null) : null;
  if (!t) return twiml(buildHangupTwiml("Sorry, this call is no longer active. Goodbye."));
  return twiml(await twimlForTarget(t, req.nextUrl.searchParams));
}
