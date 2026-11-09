import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { SchedulePatchSchema, deleteSchedule, getSchedule, updateSchedule } from "@/lib/money/recurring";
import { errorResponse, paramId, parseBody } from "@/lib/money/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing" });
    const schedule = await getSchedule(scope.dataId, await paramId(ctx));
    if (!schedule) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ schedule });
  } catch (err) {
    return errorResponse(err, "invoice-schedules.id.GET");
  }
}

/** PATCH — edit fields, or `{ status: "paused" | "active" }` to pause/resume. */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, SchedulePatchSchema);
    if (!body.ok) return body.res;
    const schedule = await updateSchedule(scope.dataId, await paramId(ctx), body.data);
    return NextResponse.json({ schedule });
  } catch (err) {
    return errorResponse(err, "invoice-schedules.id.PATCH");
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const ok = await deleteSchedule(scope.dataId, await paramId(ctx));
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "invoice-schedules.id.DELETE");
  }
}
