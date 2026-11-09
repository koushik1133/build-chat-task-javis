import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { listAudit } from "@/lib/audit";
import { normaliseCursor, page, parseListParams } from "@/lib/public-api/pagination";

export const runtime = "nodejs";

/**
 * GET /api/audit?entity=&entityId=&limit=&cursor= — org audit timeline (settings area).
 * Keyset-paginated (created_at DESC, id DESC); `before=` is still honoured for older clients.
 */
export async function GET(req: Request) {
  try {
    const scope = await requireScope({ area: "settings" });
    const url = new URL(req.url);
    const list = parseListParams(url, { limit: 50 });
    if (list.badCursor) return NextResponse.json({ error: "invalid cursor" }, { status: 400 });
    const all = await listAudit(scope.dataId, {
      entity: url.searchParams.get("entity"),
      entityId: url.searchParams.get("entityId"),
      before: url.searchParams.get("before"),
      cursor: list.cursor,
      limit: list.limit + 1,
    });
    const pg = page(all, list.limit, (r) => normaliseCursor({ created_at: r.created_at, id: r.id }));
    const rows = pg.data;
    const entries = rows.map((r) => {
      let diff: Record<string, [unknown, unknown]> | null = null;
      if (r.diff) {
        try { diff = JSON.parse(r.diff); } catch { diff = null; }
      }
      return { ...r, diff };
    });
    const last = rows[rows.length - 1];
    return NextResponse.json({ entries, next_cursor: pg.next_cursor, nextBefore: last ? last.created_at : null });
  } catch (err) {
    const res = scopeErrorResponse(err);
    if (res) return res;
    console.error("[api/audit] GET failed:", err);
    return NextResponse.json({ error: "Could not load audit log." }, { status: 500 });
  }
}
