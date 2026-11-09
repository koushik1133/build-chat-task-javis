import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import type { PortalMessageRow } from "@/lib/portal-messages";
import { listThread, listThreads, markReadByStaff, PortalMessageError, replyToContact } from "@/lib/portal-messages";
import { recordAudit } from "@/lib/audit";
import { PORTAL_MESSAGE_MAX } from "@/lib/portal-rules";

export const runtime = "nodejs";

function publicRow(r: PortalMessageRow) {
  return { id: r.id, contact_id: r.contact_id, direction: r.direction, body: r.body, author_member_id: r.author_member_id, read_at: r.read_at, created_at: r.created_at };
}

/** GET /api/portal-messages → thread summaries; ?contact_id= → that contact's thread (also returns unread count). */
export async function GET(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "crm" });
    const contactId = req.nextUrl.searchParams.get("contact_id");
    if (!contactId) return NextResponse.json({ threads: await listThreads(scope.dataId) });
    const messages = await listThread(scope.dataId, contactId);
    return NextResponse.json({ messages: messages.map(publicRow) });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

const Reply = z.object({ contact_id: z.string().min(1).max(100), body: z.string().max(PORTAL_MESSAGE_MAX * 2) }).strict();

/** POST /api/portal-messages { contact_id, body } — staff reply; emails the contact a notice with the portal link. */
export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "crm", edit: true });
    const parsed = Reply.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    const row = await replyToContact(scope.dataId, parsed.data.contact_id, parsed.data.body, scope.userId);
    await markReadByStaff(scope.dataId, parsed.data.contact_id).catch(() => undefined);
    await recordAudit(scope, { action: "portal_message.reply", entity: "portal_message", entityId: row.id, after: { contact_id: parsed.data.contact_id } });
    return NextResponse.json({ message: publicRow(row) }, { status: 201 });
  } catch (err) {
    if (err instanceof PortalMessageError) return NextResponse.json({ error: err.message }, { status: err.status });
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

const Read = z.object({ contact_id: z.string().min(1).max(100) }).strict();

/** PATCH /api/portal-messages { contact_id } — mark the customer's messages read. */
export async function PATCH(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "crm", edit: true });
    const parsed = Read.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    return NextResponse.json({ ok: true, marked: await markReadByStaff(scope.dataId, parsed.data.contact_id) });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
