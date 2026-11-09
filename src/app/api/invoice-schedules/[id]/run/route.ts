import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { getSchedule, runSchedule } from "@/lib/money/recurring";
import { errorResponse, paramId } from "@/lib/money/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/invoice-schedules/[id]/run — create the next invoice now (advances the cadence). */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const id = await paramId(ctx);
    const result = await runSchedule(scope.dataId, id, { force: true });
    if (!result.invoice_id) return NextResponse.json({ error: "bad_request", detail: result.error ?? "Schedule did not run" }, { status: 400 });
    const schedule = await getSchedule(scope.dataId, id);
    return NextResponse.json({ result, schedule }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "invoice-schedules.id.run");
  }
}
