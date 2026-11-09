import { NextRequest } from "next/server";
import { z } from "zod";
import { resolveSession, touchSession } from "@/lib/webchat/session";
import { pollMessages, postVisitorMessage } from "@/lib/webchat/service";
import { MAX_VISITOR_MESSAGE } from "@/lib/webchat/config";
import { clientIp, enforceLimits, isUuid, jsonWith, parseBody, sessionTokenFrom, widgetCors, widgetPreflight } from "@/lib/webchat/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Ctx = { params: Promise<{ siteId: string }> };
const LONG_POLL_MAX_MS = 20_000;
const LONG_POLL_STEP_MS = 2_000;

const PostSchema = z.object({ text: z.string().trim().min(1).max(MAX_VISITOR_MESSAGE) }).strict();

export async function OPTIONS(req: NextRequest, { params }: Ctx) {
  return widgetPreflight(req, (await params).siteId);
}

/** GET ?since=<iso>&wait=<ms> — poll (long-poll when `wait` > 0, capped at 20s). */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { siteId } = await params;
  const cors = await widgetCors(req, siteId);
  try {
    if (!isUuid(siteId)) return jsonWith(cors, { error: "not_found" }, 404);
    const session = await resolveSession(siteId, sessionTokenFrom(req));
    if (!session) return jsonWith(cors, { error: "unauthorized" }, 401);
    const limited = await enforceLimits(cors, [{ key: `webchat:poll:${session.id}`, limit: 120, windowMs: 60_000 }]);
    if (limited) return limited;

    const sp = new URL(req.url).searchParams;
    const since = sp.get("since");
    const wait = Math.min(Math.max(Number(sp.get("wait") ?? 0) || 0, 0), LONG_POLL_MAX_MS);
    const deadline = Date.now() + wait;
    let out = await pollMessages(session, since);
    while (out.messages.length === 0 && Date.now() + LONG_POLL_STEP_MS <= deadline) {
      await new Promise((r) => setTimeout(r, LONG_POLL_STEP_MS));
      out = await pollMessages(session, since);
    }
    void touchSession(session.id);
    return jsonWith(cors, { messages: out.messages, status: out.status, now: new Date().toISOString() }, 200, { "Cache-Control": "no-store" });
  } catch (err) {
    console.error("[webchat] poll failed:", err);
    return jsonWith(cors, { error: "internal" }, 500);
  }
}

/** POST { text } — visitor message → receptionist reply (inline) or "a human will reply". */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { siteId } = await params;
  const cors = await widgetCors(req, siteId);
  try {
    if (!isUuid(siteId)) return jsonWith(cors, { error: "not_found" }, 404);
    const session = await resolveSession(siteId, sessionTokenFrom(req));
    if (!session) return jsonWith(cors, { error: "unauthorized" }, 401);
    if (session.status === "closed") return jsonWith(cors, { error: "session_closed" }, 410);
    const limited = await enforceLimits(cors, [
      { key: `webchat:msg:session:${session.id}`, limit: 30, windowMs: 60_000 },
      { key: `webchat:msg:ip:${clientIp(req)}`, limit: 60, windowMs: 60_000 },
    ]);
    if (limited) return limited;
    const body = await parseBody(req, PostSchema, cors, 8_192);
    if ("res" in body) return body.res;

    const result = await postVisitorMessage(session, body.data.text);
    return jsonWith(cors, { reply: result.reply, pendingHuman: result.pendingHuman, messages: result.messages, now: new Date().toISOString() }, 201);
  } catch (err) {
    console.error("[webchat] message failed:", err);
    return jsonWith(cors, { error: "internal" }, 500);
  }
}
