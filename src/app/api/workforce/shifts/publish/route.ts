import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { recordAudit } from "@/lib/audit";
import { parseBody } from "@/lib/money/http";
import { workforceError, workforceScope } from "@/lib/workforce/http";
import { publishShifts } from "@/lib/workforce/shifts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ ids: z.array(z.string().min(1).max(100)).min(1).max(500) }).strict();

/** POST /api/workforce/shifts/publish {ids} — drafts → published; emits shift.published and notifies staff. */
export async function POST(req: NextRequest) {
  const s = await workforceScope(req, true);
  if (!s.ok) return s.res;
  const parsed = await parseBody(req, Body, 32_768);
  if (!parsed.ok) return parsed.res;
  try {
    const r = await publishShifts(s.scope.dataId, parsed.data.ids);
    void recordAudit(s.scope, { action: "publish", entity: "shift", after: { published: r.published.length, skipped: r.skipped.length }, req }).catch(() => undefined);
    return NextResponse.json({ published: r.published, skipped: r.skipped });
  } catch (err) {
    return workforceError(err, "workforce.shifts.publish");
  }
}
