import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { dbUnavailableResponse } from "@/lib/api-db";
import { rateLimitAsync } from "@/lib/request-limits";
import { CompleteBody, completeOnboarding } from "@/lib/onboarding/complete";

export const dynamic = "force-dynamic";

/** POST /api/onboarding/complete — idempotent: installs packs, defaults and starter agents, stamps onboarding_completed_at. */
export async function POST(req: Request) {
  let scope;
  try {
    scope = await requireScope({ area: "settings", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const limit = await rateLimitAsync(`onboarding-complete:${scope.dataId}`, 10, 60 * 60 * 1000);
  if (!limit.allowed) return NextResponse.json({ error: "rate limited" }, { status: 429 });

  const parsed = CompleteBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad request", issues: parsed.error.issues }, { status: 400 });
  try {
    const result = await completeOnboarding(scope.dataId, scope.userId, parsed.data);
    return NextResponse.json(result);
  } catch (err) {
    return dbUnavailableResponse(err, "onboarding/complete");
  }
}
