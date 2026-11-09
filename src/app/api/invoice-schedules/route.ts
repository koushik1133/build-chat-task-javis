import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { ScheduleInputSchema, createSchedule, listSchedules } from "@/lib/money/recurring";
import { errorResponse, parseBody } from "@/lib/money/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing" });
    const status = req.nextUrl.searchParams.get("status") ?? undefined;
    const schedules = await listSchedules(scope.dataId, { status });
    return NextResponse.json({ schedules });
  } catch (err) {
    return errorResponse(err, "invoice-schedules.GET");
  }
}

export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, ScheduleInputSchema);
    if (!body.ok) return body.res;
    const schedule = await createSchedule(scope.dataId, body.data);
    return NextResponse.json({ schedule }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "invoice-schedules.POST");
  }
}
