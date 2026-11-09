import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { dbUnavailableResponse } from "@/lib/api-db";
import { parseBody } from "@/lib/money/http";
import { rateLimitAsync } from "@/lib/request-limits";
import { countSections, createSnapshot, listApplications, listSnapshots, SnapshotError } from "@/lib/snapshots/store";
import { SECTION_KEYS } from "@/lib/snapshots/types";

export const dynamic = "force-dynamic";

const CreateBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).nullable().optional(),
    sections: z.array(z.enum(SECTION_KEYS)).max(SECTION_KEYS.length).optional(),
    visibility: z.enum(["private", "agency"]).optional(),
  })
  .strict();

/** GET /api/snapshots[?counts=1&applications=1] — snapshots visible to this workspace (own + agency-shared). */
export async function GET(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "settings" });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const sp = req.nextUrl.searchParams;
    const [snapshots, counts, applications] = await Promise.all([
      listSnapshots(scope.dataId),
      sp.get("counts") === "1" ? countSections(scope.dataId) : Promise.resolve(null),
      sp.get("applications") === "1" ? listApplications(scope.dataId) : Promise.resolve(null),
    ]);
    return NextResponse.json({ snapshots, ...(counts ? { counts } : {}), ...(applications ? { applications } : {}), canEdit: scope.can("settings", true) });
  } catch (err) {
    return dbUnavailableResponse(err, "snapshots");
  }
}

/** POST /api/snapshots {name, sections?, visibility?} — snapshot the current workspace's configuration. */
export async function POST(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "settings", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const rl = await rateLimitAsync(`snapshots:create:${scope.dataId}`, 20, 60 * 60 * 1000);
  if (!rl.allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const parsed = await parseBody(req, CreateBody, 8_192);
  if (!parsed.ok) return parsed.res;
  try {
    const { meta, warnings } = await createSnapshot(scope.dataId, parsed.data, { actorId: scope.userId, orgId: scope.orgId });
    return NextResponse.json({ snapshot: meta, warnings }, { status: 201 });
  } catch (err) {
    if (err instanceof SnapshotError) return NextResponse.json({ error: err.message }, { status: err.status });
    return dbUnavailableResponse(err, "snapshots");
  }
}
