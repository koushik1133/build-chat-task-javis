import { NextRequest, NextResponse } from "next/server";
import { ensureFreshAuth, getConnectionById, getLiveProvider, toContext, upsertConnection } from "@/lib/accounting/connections";
import { ACCOUNTING_STATE_COOKIE, accountingRedirectUri, verifyAccountingState } from "@/lib/accounting/oauth";
import { isLiveAccountingProviderId } from "@/lib/accounting/types";
import { recordAudit } from "@/lib/audit";
import { isResponse, settingsScope } from "../../_shared";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function settingsRedirect(req: NextRequest, params: Record<string, string>): NextResponse {
  const url = new URL("/settings/accounting", req.nextUrl.origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = NextResponse.redirect(url);
  res.cookies.set(ACCOUNTING_STATE_COOKIE, "", { httpOnly: true, path: "/api/accounting/callback", maxAge: 0 });
  return res;
}

/** OAuth return leg: verify CSRF state, exchange the code, store the connection, warm the account list. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const scope = await settingsScope();
  if (isResponse(scope)) return scope;
  const { provider: providerParam } = await ctx.params;
  if (!isLiveAccountingProviderId(providerParam) || providerParam === "simulated") return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  const provider = getLiveProvider(providerParam)!;

  const q = req.nextUrl.searchParams;
  const providerError = q.get("error_description") ?? q.get("error");
  if (providerError) return settingsRedirect(req, { error: `${provider.label}: ${providerError.slice(0, 200)}` });

  const code = q.get("code");
  const state = q.get("state");
  const cookie = req.cookies.get(ACCOUNTING_STATE_COOKIE)?.value;
  if (!code || !verifyAccountingState(state, cookie, provider.id)) {
    return settingsRedirect(req, { error: "The sign-in link was invalid or expired. Please try connecting again." });
  }
  try {
    const ex = await provider.exchangeCode(code, accountingRedirectUri(provider.id, req.url), q.get("realmId"));
    const id = await upsertConnection(scope.dataId, { provider: provider.id, auth: ex.auth, realmId: ex.realmId, tenantId: ex.tenantId, companyName: ex.companyName });
    await recordAudit(scope, { action: "accounting.connect", entity: "accounting_connection", entityId: id, after: { provider: provider.id, company: ex.companyName } });
    // Warm-up: a first listAccounts proves the token works and surfaces scope errors immediately.
    const row = await getConnectionById(id);
    if (row) await provider.listAccounts(await ensureFreshAuth(row), toContext(row)).catch((err) => console.warn("[accounting/callback] listAccounts failed:", err instanceof Error ? err.message : err));
    return settingsRedirect(req, { connected: provider.id, connection: id });
  } catch (err) {
    console.error(`[accounting/callback] ${provider.id} failed:`, err);
    return settingsRedirect(req, { error: (err instanceof Error ? err.message : "Connection failed").slice(0, 300) });
  }
}
