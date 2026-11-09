import { NextRequest, NextResponse } from "next/server";
import { getCalendarProvider, upsertConnection } from "@/lib/calsync/connections";
import { CALSYNC_STATE_COOKIE, calsyncRedirectUri, createOauthState } from "@/lib/calsync/oauth";
import { isCalendarProviderId } from "@/lib/calsync/types";
import { isEncryptionConfigured } from "@/lib/secure-store";
import { isResponse, syncScope } from "../../_shared";

export const dynamic = "force-dynamic";

function back(req: NextRequest, params: Record<string, string>): NextResponse {
  const url = new URL("/settings/calendar-sync", req.nextUrl.origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

/** Start connecting a calendar: OAuth redirect with signed CSRF state, or an immediate simulated connection. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const scope = await syncScope(true);
  if (isResponse(scope)) return scope;
  const { provider: param } = await ctx.params;
  if (!isCalendarProviderId(param)) return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  const provider = getCalendarProvider(param)!;

  if (provider.id === "simulated") {
    try {
      const ex = await provider.exchangeCode("", "");
      const id = await upsertConnection(scope.dataId, { provider: "simulated", email: ex.email, auth: ex.auth, calendarId: ex.calendarId });
      return back(req, { connected: "simulated", connection: id });
    } catch (err) {
      console.error("[calsync/connect] simulated failed:", err);
      return back(req, { error: "Could not create the simulated calendar. Has the Phase 9 migration been applied?" });
    }
  }
  if (!provider.configured()) return back(req, { error: provider.unavailableReason() ?? `${provider.label} is not configured.` });
  if (!isEncryptionConfigured()) return back(req, { error: "Set CREDENTIAL_ENCRYPTION_KEY before connecting a calendar. Tokens are stored encrypted." });

  const state = createOauthState(provider.id);
  const res = NextResponse.redirect(provider.oauthStartUrl(state, calsyncRedirectUri(provider.id, req.url)));
  res.cookies.set(CALSYNC_STATE_COOKIE, state, { httpOnly: true, sameSite: "lax", secure: req.nextUrl.protocol === "https:", path: "/api/calsync/callback", maxAge: 600 });
  return res;
}
