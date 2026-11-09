import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { dbUnavailableResponse } from "@/lib/api-db";
import { getOnboardingStatus, mergeOrgSettings } from "@/lib/onboarding/status";

export const dynamic = "force-dynamic";

/** GET /api/onboarding/status — completion flags + the "Finish setup" checklist. */
export async function GET() {
  let scope;
  try {
    scope = await requireScope({});
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const status = await getOnboardingStatus(scope.dataId, scope.orgId);
    return NextResponse.json({ ...status, canEdit: scope.can("settings", true) });
  } catch (err) {
    return dbUnavailableResponse(err, "onboarding/status");
  }
}

const Patch = z.object({ dismissed: z.boolean() }).strict();

/** PATCH /api/onboarding/status — dismiss (or restore) the checklist card. */
export async function PATCH(req: Request) {
  let scope;
  try {
    scope = await requireScope({ area: "settings", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad request", issues: parsed.error.issues }, { status: 400 });
  try {
    await mergeOrgSettings(scope.dataId, { onboarding_checklist_dismissed: parsed.data.dismissed });
    return NextResponse.json({ ok: true, dismissed: parsed.data.dismissed });
  } catch (err) {
    return dbUnavailableResponse(err, "onboarding/status");
  }
}
