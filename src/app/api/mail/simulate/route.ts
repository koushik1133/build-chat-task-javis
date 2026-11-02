import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { getMailAccount } from "@/lib/mail";
import { pushSimulatedMail } from "@/lib/mail/providers/simulated";
import { syncAccount } from "@/lib/mail/sync";
import { rateLimit } from "@/lib/request-limits";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const bodySchema = z
  .object({
    accountId: z.string().min(1).max(100),
    from: z.string().trim().email().max(200),
    subject: z.string().trim().min(1).max(300),
    body: z.string().trim().min(1).max(10_000),
    threadId: z.string().max(200).optional(),
  })
  .strict();

/**
 * Push an email into a simulated mailbox and sync it, so the whole inbox
 * pipeline can be demoed without Gmail or Outlook. Refuses on real accounts.
 */
export async function POST(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "settings", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!rateLimit(`mail-sim:${scope.dataId}`, 30, 60_000).allowed) {
    return NextResponse.json({ error: "Too many simulated emails — slow down." }, { status: 429 });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  }
  try {
    const account = await getMailAccount(scope.dataId, parsed.data.accountId);
    if (!account) return NextResponse.json({ error: "Account not found" }, { status: 404 });
    if (account.provider !== "simulated") {
      return NextResponse.json({ error: "Only simulated mailboxes accept test emails." }, { status: 400 });
    }
    const msg = pushSimulatedMail(account.id, { from: parsed.data.from, subject: parsed.data.subject, body: parsed.data.body, threadId: parsed.data.threadId ?? null });
    const result = await syncAccount(account.id);
    if (result.error) return NextResponse.json({ error: result.error }, { status: 502 });
    return NextResponse.json({ ok: true, messageId: msg.providerMessageId, ...result });
  } catch (err) {
    console.error("[mail/simulate] failed:", err);
    return NextResponse.json({ error: "Could not simulate that email." }, { status: 500 });
  }
}
