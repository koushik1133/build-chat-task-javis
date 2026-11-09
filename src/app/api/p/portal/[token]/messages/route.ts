import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { rateLimitAsync } from "@/lib/request-limits";
import { authPortalToken, clientIp } from "@/lib/portal-auth";
import { listThread, markReadByContact, PortalMessageError, receiveFromContact, toPublicMessage } from "@/lib/portal-messages";
import { PORTAL_MESSAGE_MAX } from "@/lib/portal-rules";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ token: string }> };

/** GET /api/p/portal/[token]/messages?since=<iso> → { messages } (staff replies are marked read). */
export async function GET(req: NextRequest, ctx: Ctx) {
  if (!(await rateLimitAsync(`portal-msg-read:${clientIp(req)}`, 120, 60_000)).allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  try {
    const auth = await authPortalToken((await ctx.params).token);
    if (!auth) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const rows = await listThread(auth.dataId, auth.contactId, { since: req.nextUrl.searchParams.get("since"), sinceId: req.nextUrl.searchParams.get("sinceId")?.slice(0, 64) ?? null });
    if (req.nextUrl.searchParams.get("markRead") === "1") await markReadByContact(auth.dataId, auth.contactId);
    return NextResponse.json({ messages: rows.map(toPublicMessage) });
  } catch (err) {
    console.error("[portal] messages GET failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

const Body = z.object({ body: z.string().max(PORTAL_MESSAGE_MAX * 2) }).strict();

/** POST /api/p/portal/[token]/messages — { body } plain text, ≤ 2000 chars, rate-limited. */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const auth = await authPortalToken((await ctx.params).token);
    if (!auth) return NextResponse.json({ error: "not_found" }, { status: 404 });
    // Per contact (not just per IP) so a shared link cannot flood the staff inbox.
    const limited = !(await rateLimitAsync(`portal-msg:${auth.contactId}`, 10, 60_000)).allowed || !(await rateLimitAsync(`portal-msg-hr:${auth.contactId}`, 100, 3_600_000)).allowed || !(await rateLimitAsync(`portal-msg-ip:${clientIp(req)}`, 20, 60_000)).allowed;
    if (limited) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "invalid_request", message: `Message is too long (max ${PORTAL_MESSAGE_MAX} characters).` }, { status: 400 });
    try {
      const row = await receiveFromContact(auth.dataId, auth.contactId, parsed.data.body);
      return NextResponse.json({ message: toPublicMessage(row) }, { status: 201 });
    } catch (err) {
      if (err instanceof PortalMessageError) return NextResponse.json({ error: "invalid_request", message: err.message }, { status: err.status });
      throw err;
    }
  } catch (err) {
    console.error("[portal] messages POST failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
