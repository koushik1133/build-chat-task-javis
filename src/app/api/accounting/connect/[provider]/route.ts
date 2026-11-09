import { NextRequest, NextResponse } from "next/server";
import { getLiveProvider, upsertConnection } from "@/lib/accounting/connections";
import { ACCOUNTING_STATE_COOKIE, accountingRedirectUri, createAccountingState } from "@/lib/accounting/oauth";
import { isLiveAccountingProviderId } from "@/lib/accounting/types";
import { recordAudit } from "@/lib/audit";
import { isEncryptionConfigured } from "@/lib/secure-store";
import { isResponse, settingsScope } from "../../_shared";

export const dynamic = "force-dynamic";

function settingsRedirect(req: NextRequest, params: Record<string, string>): NextResponse {
  const url = new URL("/settings/accounting", req.nextUrl.origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

/** Start connecting: OAuth providers redirect to consent with a signed CSRF state; simulated connects on the spot. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const scope = await settingsScope();
  if (isResponse(scope)) return scope;
  const { provider: providerParam } = await ctx.params;
  if (!isLiveAccountingProviderId(providerParam)) return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  const provider = getLiveProvider(providerParam)!;

  if (provider.id === "simulated") {
    try {
      const ex = await provider.exchangeCode("", "");
      const id = await upsertConnection(scope.dataId, { provider: "simulated", auth: ex.auth, realmId: ex.realmId, tenantId: ex.tenantId, companyName: ex.companyName });
      await recordAudit(scope, { action: "accounting.connect", entity: "accounting_connection", entityId: id, after: { provider: "simulated" } });
      return settingsRedirect(req, { connected: "simulated", connection: id });
    } catch (err) {
      console.error("[accounting/connect] simulated failed:", err);
      return settingsRedirect(req, { error: "Could not create the simulated ledger. Has the Phase 5 migration been applied?" });
    }
  }
  if (!provider.configured()) return settingsRedirect(req, { error: provider.unavailableReason() ?? `${provider.label} is not configured.` });
  if (!isEncryptionConfigured()) return settingsRedirect(req, { error: "Set CREDENTIAL_ENCRYPTION_KEY before connecting — tokens are stored encrypted." });

  const state = createAccountingState(provider.id);
  const res = NextResponse.redirect(provider.oauthStartUrl(state, accountingRedirectUri(provider.id, req.url)));
  res.cookies.set(ACCOUNTING_STATE_COOKIE, state, { httpOnly: true, sameSite: "lax", secure: req.nextUrl.protocol === "https:", path: "/api/accounting/callback", maxAge: 600 });
  return res;
}
