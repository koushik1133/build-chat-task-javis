import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { recordAudit } from "@/lib/audit";
import { parseBody } from "@/lib/money/http";
import { workforceError, workforceScope } from "@/lib/workforce/http";
import { copyWeek } from "@/lib/workforce/shifts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Body = z.object({ source_week: Ymd, target_week: Ymd.optional() }).strict();

/** POST /api/workforce/shifts/copy-week {source_week, target_week?} — copies a week's shifts forward as drafts. */
export async function POST(req: NextRequest) {
  const s = await workforceScope(req, true);
  if (!s.ok) return s.res;
  const parsed = await parseBody(req, Body, 4_096);
  if (!parsed.ok) return parsed.res;
  try {
    const r = await copyWeek(s.scope.dataId, parsed.data.source_week, parsed.data.target_week);
    void recordAudit(s.scope, { action: "copy_week", entity: "shift", after: { ...parsed.data, ...r }, req }).catch(() => undefined);
    return NextResponse.json(r);
  } catch (err) {
    return workforceError(err, "workforce.shifts.copy");
  }
}
