import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { countUnreadInApp, listOutbox, markInAppRead, parseOutboxData, type OutboxStatus } from "@/lib/notifications/outbox";
import { channelStatus, isNotificationChannel } from "@/lib/notifications/status";

export const runtime = "nodejs";

const STATUSES: readonly OutboxStatus[] = ["queued", "sent", "simulated", "failed", "read"];

/**
 * GET /api/notifications/outbox
 *   ?unread=1                → unread in-app rows for the bell (any member)
 *   ?channel=&status=&limit= → full outbox for the dev view (settings area)
 * PATCH { ids: string[] } | { all: true } → mark in-app rows read (any member)
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const unreadOnly = url.searchParams.get("unread") === "1";
  try {
    const scope = unreadOnly ? await requireScope() : await requireScope({ area: "settings" });
    if (unreadOnly) {
      const [rows, unread] = await Promise.all([
        listOutbox(scope.dataId, { unreadInApp: true, limit: 30 }),
        countUnreadInApp(scope.dataId),
      ]);
      const notifications = rows.map((r) => ({
        id: r.id,
        title: r.subject ?? "Notification",
        body: r.body,
        read: false,
        created_at: r.created_at,
        data: parseOutboxData(r),
      }));
      return NextResponse.json({ notifications, unread });
    }

    const channelParam = url.searchParams.get("channel");
    const statusParam = url.searchParams.get("status");
    const limit = Number(url.searchParams.get("limit") ?? "100");
    const rows = await listOutbox(scope.dataId, {
      channel: isNotificationChannel(channelParam) ? channelParam : null,
      status: STATUSES.includes(statusParam as OutboxStatus) ? (statusParam as OutboxStatus) : null,
      limit: Number.isFinite(limit) ? limit : 100,
    });
    return NextResponse.json({
      rows: rows.map((r) => ({ ...r, data: parseOutboxData(r) })),
      channels: channelStatus(),
    });
  } catch (err) {
    const res = scopeErrorResponse(err);
    if (res) return res;
    console.error("[api/notifications/outbox] GET failed:", err);
    return NextResponse.json({ error: "Could not load notifications." }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const scope = await requireScope();
    const body = (await req.json().catch(() => null)) as { ids?: unknown; all?: unknown; read?: unknown } | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    if (body.read === false) return NextResponse.json({ error: "Only read:true is supported" }, { status: 400 });
    if (body.all === true) {
      await markInAppRead(scope.dataId, "all");
    } else if (Array.isArray(body.ids) && body.ids.length > 0) {
      await markInAppRead(scope.dataId, body.ids.map(String));
    } else {
      return NextResponse.json({ error: "ids[] or all:true required" }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const res = scopeErrorResponse(err);
    if (res) return res;
    console.error("[api/notifications/outbox] PATCH failed:", err);
    return NextResponse.json({ error: "Could not update notifications." }, { status: 500 });
  }
}
