import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { ensureDefaultRules, listRules } from "@/lib/alerts/store";
import { METRICS } from "@/lib/alerts/evaluate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/alerts/rules — org rules (defaults seeded lazily, idempotent) plus the metric catalogue. */
export async function GET() {
  let scope;
  try { scope = await requireScope({ area: "settings", edit: false }); } catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  try {
    await ensureDefaultRules(scope.dataId);
    const rules = await listRules(scope.dataId);
    return NextResponse.json({ rules, metrics: METRICS.filter((m) => m.scope === "org"), email: scope.email ?? null });
  } catch (err) {
    console.error("[api/alerts/rules] GET failed:", err);
    return NextResponse.json({ error: "Could not load alert rules." }, { status: 500 });
  }
}
