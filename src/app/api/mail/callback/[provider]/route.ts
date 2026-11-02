import { NextRequest, NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { getMailProvider, isMailProviderId, upsertMailAccount } from "@/lib/mail";
import { MAIL_STATE_COOKIE, mailRedirectUri, verifyOauthState } from "@/lib/mail/oauth";
import { syncAccount } from "@/lib/mail/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function settingsRedirect(req: NextRequest, params: Record<string, string>): NextResponse {
  const url = new URL("/settings/mail", req.nextUrl.origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = NextResponse.redirect(url);
  res.cookies.set(MAIL_STATE_COOKIE, "", { httpOnly: true, path: "/api/mail/callback", maxAge: 0 });
  return res;
}

/** OAuth return leg: verify the CSRF state, swap the code for tokens, store the account, run a first sync. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  let scope;
  try {
    scope = await requireScope({ area: "settings", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { provider: providerParam } = await ctx.params;
  if (!isMailProviderId(providerParam) || providerParam === "simulated") {
    return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  }
  const provider = getMailProvider(providerParam)!;

  const q = req.nextUrl.searchParams;
  const providerError = q.get("error_description") ?? q.get("error");
  if (providerError) return settingsRedirect(req, { error: `${provider.label}: ${providerError.slice(0, 200)}` });

  const code = q.get("code");
  const state = q.get("state");
  const cookie = req.cookies.get(MAIL_STATE_COOKIE)?.value;
  if (!code || !verifyOauthState(state, cookie, provider.id)) {
    return settingsRedirect(req, { error: "The sign-in link was invalid or expired. Please try connecting again." });
  }

  try {
    const ex = await provider.exchangeCode(code, mailRedirectUri(provider.id, req.url));
    const id = await upsertMailAccount(scope.dataId, { provider: provider.id, email: ex.email, displayName: ex.displayName, auth: ex.auth, cursor: ex.cursor });
    // Best effort: a first pull so the inbox is not empty when the page loads.
    await syncAccount(id).catch(() => undefined);
    return settingsRedirect(req, { connected: provider.id, account: id });
  } catch (err) {
    console.error(`[mail/callback] ${provider.id} failed:`, err);
    const message = err instanceof Error ? err.message : "Connection failed";
    return settingsRedirect(req, { error: message.slice(0, 300) });
  }
}
