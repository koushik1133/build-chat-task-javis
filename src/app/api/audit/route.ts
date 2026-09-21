import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { listAudit } from "@/lib/audit";

export const runtime = "nodejs";

/** GET /api/audit?entity=&entityId=&limit=&before= — org audit timeline (settings area). */
export async function GET(req: Request) {
  try {
    const scope = await requireScope({ area: "settings" });
    const url = new URL(req.url);
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const rows = await listAudit(scope.dataId, {
      entity: url.searchParams.get("entity"),
      entityId: url.searchParams.get("entityId"),
      before: url.searchParams.get("before"),
      limit: Number.isFinite(limit) ? limit : 50,
    });
    const entries = rows.map((r) => {
      let diff: Record<string, [unknown, unknown]> | null = null;
      if (r.diff) {
        try { diff = JSON.parse(r.diff); } catch { diff = null; }
      }
      return { ...r, diff };
    });
    const last = rows[rows.length - 1];
    return NextResponse.json({ entries, nextBefore: last ? last.created_at : null });
  } catch (err) {
    const res = scopeErrorResponse(err);
    if (res) return res;
    console.error("[api/audit] GET failed:", err);
    return NextResponse.json({ error: "Could not load audit log." }, { status: 500 });
  }
}
