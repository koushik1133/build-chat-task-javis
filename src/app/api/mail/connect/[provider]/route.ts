import { NextRequest, NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { getMailProvider, isMailProviderId, upsertMailAccount } from "@/lib/mail";
import { createOauthState, MAIL_STATE_COOKIE, mailRedirectUri } from "@/lib/mail/oauth";
import { isEncryptionConfigured } from "@/lib/secure-store";

export const dynamic = "force-dynamic";

function settingsRedirect(req: NextRequest, params: Record<string, string>): NextResponse {
  const url = new URL("/settings/mail", req.nextUrl.origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

/**
 * Start connecting a mailbox. OAuth providers get a redirect to the consent
 * screen with a signed CSRF state (mirrored in an HttpOnly cookie); the
 * simulated provider creates its account on the spot.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  let scope;
  try {
    scope = await requireScope({ area: "settings", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { provider: providerParam } = await ctx.params;
  if (!isMailProviderId(providerParam)) return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  const provider = getMailProvider(providerParam)!;

  if (provider.id === "simulated") {
    try {
      const ex = await provider.exchangeCode("", "");
      const id = await upsertMailAccount(scope.dataId, { provider: "simulated", email: ex.email, displayName: ex.displayName, auth: ex.auth, cursor: ex.cursor });
      return settingsRedirect(req, { connected: "simulated", account: id });
    } catch (err) {
      console.error("[mail/connect] simulated failed:", err);
      return settingsRedirect(req, { error: "Could not create the simulated inbox. Has the Phase 4 migration been applied?" });
    }
  }

  if (!provider.configured()) {
    return settingsRedirect(req, { error: provider.unavailableReason() ?? `${provider.label} is not configured.` });
  }
  if (!isEncryptionConfigured()) {
    return settingsRedirect(req, { error: "Set CREDENTIAL_ENCRYPTION_KEY before connecting a mailbox — tokens are stored encrypted." });
  }

  const state = createOauthState(provider.id);
  const res = NextResponse.redirect(provider.oauthStartUrl(state, mailRedirectUri(provider.id, req.url)));
  res.cookies.set(MAIL_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.nextUrl.protocol === "https:",
    path: "/api/mail/callback",
    maxAge: 600,
  });
  return res;
}
