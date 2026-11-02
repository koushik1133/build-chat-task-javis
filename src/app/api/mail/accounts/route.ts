import { NextRequest, NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { deleteMailAccount, describeMailProviders, listMailAccounts } from "@/lib/mail";
import { tableExists } from "@/lib/table-exists";

export const dynamic = "force-dynamic";

/** Connected mailboxes (never includes credentials) plus provider availability. */
export async function GET() {
  let scope;
  try {
    scope = await requireScope({ area: "settings", edit: false });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const ready = await tableExists("mail_accounts");
    const accounts = ready ? await listMailAccounts(scope.dataId) : [];
    return NextResponse.json({ accounts, providers: describeMailProviders(), migrated: ready });
  } catch (err) {
    console.error("[mail/accounts] list failed:", err);
    return NextResponse.json({ error: "Could not load mail accounts." }, { status: 500 });
  }
}

/** Disconnect a mailbox: removes its synced messages and credentials. */
export async function DELETE(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "settings", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const id = req.nextUrl.searchParams.get("id")?.trim() ?? "";
  if (!id || id.length > 100) return NextResponse.json({ error: "id is required" }, { status: 400 });
  try {
    const ok = await deleteMailAccount(scope.dataId, id);
    if (!ok) return NextResponse.json({ error: "Account not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[mail/accounts] delete failed:", err);
    return NextResponse.json({ error: "Could not disconnect that account." }, { status: 500 });
  }
}
