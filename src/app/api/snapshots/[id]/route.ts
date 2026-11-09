import { NextResponse, type NextRequest } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { dbUnavailableResponse } from "@/lib/api-db";
import { deleteSnapshot, getSnapshotDoc, SnapshotError } from "@/lib/snapshots/store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/snapshots/:id[?download=1] — metadata, or the raw snapshot JSON as a download. */
export async function GET(req: NextRequest, ctx: Ctx) {
  let scope;
  try {
    scope = await requireScope({ area: "settings" });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    const found = await getSnapshotDoc(scope.dataId, id);
    if (!found) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (req.nextUrl.searchParams.get("download") === "1") {
      const file = `${found.meta.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "snapshot"}.snapshot.json`;
      return new NextResponse(found.json, {
        headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="${file}"`, "x-snapshot-sha256": found.meta.sha256, "cache-control": "no-store" },
      });
    }
    return NextResponse.json({ snapshot: found.meta });
  } catch (err) {
    if (err instanceof SnapshotError) return NextResponse.json({ error: err.message }, { status: err.status });
    return dbUnavailableResponse(err, "snapshots/[id]");
  }
}

/** DELETE /api/snapshots/:id — only the workspace's own snapshots. */
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  let scope;
  try {
    scope = await requireScope({ area: "settings", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    const ok = await deleteSnapshot(scope.dataId, id, scope.userId);
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "not_found" }, { status: 404 });
  } catch (err) {
    return dbUnavailableResponse(err, "snapshots/[id]");
  }
}
