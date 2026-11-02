import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { getMailAccount } from "@/lib/mail";
import { syncAccount } from "@/lib/mail/sync";
import { rateLimit } from "@/lib/request-limits";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Sync one mailbox right now (the cron does the same every 2 minutes). */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let scope;
  try {
    scope = await requireScope({ area: "settings", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  if (!rateLimit(`mail-sync:${scope.dataId}`, 20, 60_000).allowed) {
    return NextResponse.json({ error: "Too many syncs — wait a minute." }, { status: 429 });
  }
  try {
    const account = await getMailAccount(scope.dataId, id);
    if (!account) return NextResponse.json({ error: "Account not found" }, { status: 404 });
    const result = await syncAccount(account.id);
    return NextResponse.json({ ok: !result.error, ...result }, { status: result.error ? 502 : 200 });
  } catch (err) {
    console.error("[mail/sync] failed:", err);
    return NextResponse.json({ error: "Sync failed." }, { status: 500 });
  }
}
