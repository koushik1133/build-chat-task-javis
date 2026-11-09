import { NextRequest, NextResponse } from "next/server";
import { getCalendarProvider, upsertConnection } from "@/lib/calsync/connections";
import { CALSYNC_STATE_COOKIE, calsyncRedirectUri, verifyOauthState } from "@/lib/calsync/oauth";
import { syncConnection } from "@/lib/calsync/sync";
import { isCalendarProviderId } from "@/lib/calsync/types";
import { isResponse, syncScope } from "../../_shared";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function back(req: NextRequest, params: Record<string, string>): NextResponse {
  const url = new URL("/settings/calendar-sync", req.nextUrl.origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = NextResponse.redirect(url);
  res.cookies.set(CALSYNC_STATE_COOKIE, "", { httpOnly: true, path: "/api/calsync/callback", maxAge: 0 });
  return res;
}

/** OAuth return leg: verify CSRF state, swap the code for tokens, store the connection, run a first sync. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const scope = await syncScope(true);
  if (isResponse(scope)) return scope;
  const { provider: param } = await ctx.params;
  if (!isCalendarProviderId(param) || param === "simulated") return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  const provider = getCalendarProvider(param)!;

  const q = req.nextUrl.searchParams;
  const providerError = q.get("error_description") ?? q.get("error");
  if (providerError) return back(req, { error: `${provider.label}: ${providerError.slice(0, 200)}` });
  const code = q.get("code");
  if (!code || !verifyOauthState(q.get("state"), req.cookies.get(CALSYNC_STATE_COOKIE)?.value, provider.id)) {
    return back(req, { error: "The sign-in link was invalid or expired. Please try connecting again." });
  }
  try {
    const ex = await provider.exchangeCode(code, calsyncRedirectUri(provider.id, req.url));
    if (!ex.email) throw new Error("The provider did not return an account email.");
    const id = await upsertConnection(scope.dataId, { provider: provider.id, email: ex.email, auth: ex.auth, calendarId: ex.calendarId });
    await syncConnection(id).catch(() => undefined);
    return back(req, { connected: provider.id, connection: id });
  } catch (err) {
    console.error(`[calsync/callback] ${provider.id} failed:`, err);
    return back(req, { error: (err instanceof Error ? err.message : "Connection failed").slice(0, 300) });
  }
}
