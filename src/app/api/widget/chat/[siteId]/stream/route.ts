import { NextRequest } from "next/server";
import { resolveSession } from "@/lib/webchat/session";
import { pollMessages } from "@/lib/webchat/service";
import { sseComment, sseFrame } from "@/lib/webchat/config";
import { clientIp, enforceLimits, isUuid, jsonWith, sessionTokenFrom, widgetCors, widgetPreflight, withHeaders } from "@/lib/webchat/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ siteId: string }> };
const STREAM_MAX_MS = 55_000;
const STREAM_STEP_MS = 2_000;

export async function OPTIONS(req: NextRequest, { params }: Ctx) {
  return widgetPreflight(req, (await params).siteId);
}

/**
 * GET /api/widget/chat/[siteId]/stream?token=&since= — SSE. Polls the DB every
 * 2s and closes after 55s; the client reconnects with the last `ts` as `since`.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { siteId } = await params;
  const cors = await widgetCors(req, siteId);
  if (!isUuid(siteId)) return jsonWith(cors, { error: "not_found" }, 404);
  const session = await resolveSession(siteId, sessionTokenFrom(req, { allowQuery: true }));
  if (!session) return jsonWith(cors, { error: "unauthorized" }, 401);
  if (session.status === "closed") return jsonWith(cors, { error: "session_closed" }, 410);
  const limited = await enforceLimits(cors, [
    { key: `webchat:stream:${session.id}`, limit: 30, windowMs: 60_000 },
    { key: `webchat:stream:ip:${clientIp(req)}`, limit: 60, windowMs: 60_000 },
  ]);
  if (limited) return limited;

  let since = new URL(req.url).searchParams.get("since");
  const encoder = new TextEncoder();
  const started = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => controller.enqueue(encoder.encode(s));
      send(sseComment("connected"));
      let closed = false;
      const onAbort = () => {
        closed = true;
      };
      req.signal.addEventListener("abort", onAbort);
      try {
        while (!closed && Date.now() - started < STREAM_MAX_MS) {
          const out = await pollMessages(session, since).catch(() => null);
          if (out && out.messages.length) {
            since = out.messages[out.messages.length - 1].ts;
            send(sseFrame("messages", { messages: out.messages, status: out.status }, since));
          } else {
            send(sseComment("keepalive"));
          }
          if (out?.status === "closed") break;
          await new Promise((r) => setTimeout(r, STREAM_STEP_MS));
        }
        if (!closed) send(sseFrame("end", { since }));
      } finally {
        req.signal.removeEventListener("abort", onAbort);
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      }
    },
  });

  return withHeaders(
    new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" },
    }),
    cors
  );
}
