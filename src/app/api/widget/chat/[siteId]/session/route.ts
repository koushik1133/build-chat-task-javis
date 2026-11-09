import { NextRequest } from "next/server";
import { z } from "zod";
import { startSession, resolveSession, closeSession } from "@/lib/webchat/session";
import { clientIp, enforceLimits, isUuid, jsonWith, parseBody, sessionTokenFrom, widgetCors, widgetPreflight } from "@/lib/webchat/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ siteId: string }> };

const StartSchema = z.object({
  visitorId: z.string().min(1).max(80).optional(),
  pageUrl: z.string().max(1000).optional(),
}).strict();

export async function OPTIONS(req: NextRequest, { params }: Ctx) {
  return widgetPreflight(req, (await params).siteId);
}

/** POST /api/widget/chat/[siteId]/session — start a session → { token, expiresAt, sessionId } */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { siteId } = await params;
  const cors = await widgetCors(req, siteId);
  try {
    if (!isUuid(siteId)) return jsonWith(cors, { error: "not_found" }, 404);
    const ip = clientIp(req);
    const limited = await enforceLimits(cors, [
      { key: `webchat:start:ip:${ip}`, limit: 20, windowMs: 60 * 60 * 1000 },
      { key: `webchat:start:site:${siteId}`, limit: 600, windowMs: 60 * 60 * 1000 },
    ]);
    if (limited) return limited;
    const body = await parseBody(req, StartSchema, cors, 4_096);
    if ("res" in body) return body.res;

    const started = await startSession(siteId, { visitorId: body.data.visitorId, pageUrl: body.data.pageUrl, userAgent: req.headers.get("user-agent"), ip });
    if (!started) return jsonWith(cors, { error: "not_found" }, 404);
    return jsonWith(cors, { sessionId: started.session.id, token: started.token, expiresAt: started.expiresAt, status: started.session.status }, 201);
  } catch (err) {
    console.error("[webchat] session start failed:", err);
    return jsonWith(cors, { error: "internal" }, 500);
  }
}

/** DELETE /api/widget/chat/[siteId]/session — close the visitor's session. */
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { siteId } = await params;
  const cors = await widgetCors(req, siteId);
  try {
    if (!isUuid(siteId)) return jsonWith(cors, { error: "not_found" }, 404);
    const session = await resolveSession(siteId, sessionTokenFrom(req));
    if (!session) return jsonWith(cors, { error: "unauthorized" }, 401);
    await closeSession(session.id);
    return jsonWith(cors, { ok: true, status: "closed" });
  } catch (err) {
    console.error("[webchat] session close failed:", err);
    return jsonWith(cors, { error: "internal" }, 500);
  }
}
