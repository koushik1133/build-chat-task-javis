import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { closeSession, getSession, listSessions, setSessionStatus } from "@/lib/webchat/session";
import { takeOverByConversation, unansweredCount } from "@/lib/webchat/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/webchat/sessions?status=active|open|handed_off|closed|all — staff view of web chat sessions. */
export async function GET(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "messaging", edit: false });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const status = z.enum(["active", "open", "handed_off", "closed", "all"]).catch("active").parse(req.nextUrl.searchParams.get("status") ?? "active");
    const [sessions, counts] = await Promise.all([listSessions(scope.dataId, { status, limit: 100 }), unansweredCount(scope.dataId)]);
    return NextResponse.json({ sessions, counts });
  } catch (err) {
    console.error("[webchat] sessions GET failed:", err);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

const PatchSchema = z
  .object({
    sessionId: z.string().uuid().optional(),
    conversationId: z.string().min(1).max(100).optional(),
    action: z.enum(["take_over", "close", "reopen"]),
  })
  .strict()
  .refine((v) => Boolean(v.sessionId || v.conversationId), { message: "sessionId or conversationId is required" });

/** PATCH — take over (stop auto replies), close or reopen a session. */
export async function PATCH(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "messaging", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  try {
    let session = parsed.data.sessionId ? await getSession(scope.dataId, parsed.data.sessionId) : null;
    if (!session && parsed.data.conversationId) session = await takeOverByConversation(scope.dataId, parsed.data.conversationId).then((s) => s);
    if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    if (parsed.data.action === "take_over" && session.status === "open") await setSessionStatus(session.id, "handed_off");
    if (parsed.data.action === "close") await closeSession(session.id);
    if (parsed.data.action === "reopen") await setSessionStatus(session.id, "handed_off");
    const fresh = await getSession(scope.dataId, session.id);
    return NextResponse.json({ session: fresh });
  } catch (err) {
    console.error("[webchat] sessions PATCH failed:", err);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
