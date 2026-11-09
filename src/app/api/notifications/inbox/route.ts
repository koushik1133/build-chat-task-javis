import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { assignedDigest, inboxUnreadCount, listInbox, markRead, snooze } from "@/lib/inbox/store";
import { normaliseCursor, page, parseListParams } from "@/lib/public-api/pagination";

export const runtime = "nodejs";

/**
 * GET /api/notifications/inbox?unread=1&category=&limit=&cursor=
 *   Unified activity feed for the caller (their in-app notifications, newest
 *   first, keyset-paginated) plus the unread count and an "assigned to me" digest.
 * PATCH { action: "read" | "snooze", ids?: string[], all?: true, snooze?: "1h"|"tomorrow", tz_offset?: number }
 */
export async function GET(req: Request) {
  try {
    const scope = await requireScope();
    const url = new URL(req.url);
    const list = parseListParams(url, { limit: 30 });
    if (list.badCursor) return NextResponse.json({ error: "invalid cursor" }, { status: 400 });
    const category = url.searchParams.get("category");
    const rows = await listInbox(scope.dataId, scope.userId, {
      unread: url.searchParams.get("unread") === "1",
      category: category && /^[a-z_]{1,30}$/.test(category) ? category : null,
      cursor: list.cursor,
      limit: list.limit + 1,
    });
    const pg = page(rows, list.limit, (r) => normaliseCursor({ created_at: r.created_at, id: r.id }));
    const [unread, digest] = await Promise.all([inboxUnreadCount(scope.dataId, scope.userId), assignedDigest(scope.dataId, scope.userId)]);
    return NextResponse.json({ items: pg.data, next_cursor: pg.next_cursor, unread, digest });
  } catch (err) {
    const res = scopeErrorResponse(err);
    if (res) return res;
    console.error("[api/notifications/inbox] GET failed:", err);
    return NextResponse.json({ error: "Could not load inbox." }, { status: 500 });
  }
}

const Patch = z
  .object({
    action: z.enum(["read", "snooze"]),
    ids: z.array(z.string().min(1).max(100)).max(200).optional(),
    all: z.literal(true).optional(),
    snooze: z.enum(["1h", "tomorrow"]).optional(),
    tz_offset: z.number().int().min(-840).max(840).optional(),
  })
  .strict();

export async function PATCH(req: Request) {
  try {
    const scope = await requireScope();
    const parsed = Patch.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    const b = parsed.data;
    if (b.action === "read") {
      if (!b.all && !b.ids?.length) return NextResponse.json({ error: "ids[] or all:true required" }, { status: 400 });
      const count = await markRead(scope.dataId, scope.userId, b.all ? "all" : (b.ids as string[]));
      return NextResponse.json({ ok: true, count });
    }
    if (!b.ids?.length || !b.snooze) return NextResponse.json({ error: "ids[] and snooze required" }, { status: 400 });
    const out = await snooze(scope.dataId, scope.userId, b.ids, b.snooze, b.tz_offset ?? 0);
    return NextResponse.json({ ok: true, ...out });
  } catch (err) {
    const res = scopeErrorResponse(err);
    if (res) return res;
    console.error("[api/notifications/inbox] PATCH failed:", err);
    return NextResponse.json({ error: "Could not update inbox." }, { status: 500 });
  }
}
