import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { memberErrorResponse } from "@/lib/memberships/http";
import { loadMetrics } from "@/lib/memberships/subscriptions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const scope = await requireScope({ area: "billing", edit: false });
    return NextResponse.json({ metrics: await loadMetrics(scope.dataId) });
  } catch (err) {
    return memberErrorResponse(err, "memberships.metrics.GET");
  }
}
