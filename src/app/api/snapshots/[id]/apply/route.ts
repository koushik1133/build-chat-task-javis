import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { dbUnavailableResponse } from "@/lib/api-db";
import { parseBody } from "@/lib/money/http";
import { rateLimitAsync } from "@/lib/request-limits";
import { applySnapshot, getSnapshotDoc, SnapshotError } from "@/lib/snapshots/store";
import { SECTION_KEYS } from "@/lib/snapshots/types";

export const dynamic = "force-dynamic";

const Body = z
  .object({
    /** Only "self" is supported: a snapshot is applied to the active workspace. */
    target: z.literal("self").optional(),
    sections: z.array(z.enum(SECTION_KEYS)).max(SECTION_KEYS.length).optional(),
    mode: z.enum(["merge", "skip_existing"]).default("skip_existing"),
  })
  .strict();

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/snapshots/:id/apply {sections?, mode} */
export async function POST(req: NextRequest, ctx: Ctx) {
  let scope;
  try {
    scope = await requireScope({ area: "settings", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const rl = await rateLimitAsync(`snapshots:apply:${scope.dataId}`, 30, 60 * 60 * 1000);
  if (!rl.allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const parsed = await parseBody(req, Body, 4_096);
  if (!parsed.ok) return parsed.res;
  const { id } = await ctx.params;
  try {
    const found = await getSnapshotDoc(scope.dataId, id);
    if (!found) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const result = await applySnapshot(scope.dataId, found.doc, { ...parsed.data, actorId: scope.userId, snapshotId: found.meta.id, snapshotSha: found.meta.sha256 });
    return NextResponse.json({ result }, { status: result.status === "failed" ? 422 : 200 });
  } catch (err) {
    if (err instanceof SnapshotError) return NextResponse.json({ error: err.message }, { status: err.status });
    return dbUnavailableResponse(err, "snapshots/apply");
  }
}
