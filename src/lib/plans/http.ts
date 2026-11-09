import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse, type Scope } from "@/lib/auth/scope";
import type { FeatureKey, Metric } from "./catalog";
import { assertFeature, assertWithinLimit, isPlanLimitError, upgradeUrl, type PlanLimitError } from "./enforce";

/** Map a PlanLimitError to HTTP 402 `{error:"plan_limit", ...}`; null for anything else. */
export function planLimitResponse(err: unknown): NextResponse | null {
  if (!isPlanLimitError(err)) return null;
  const e = err as PlanLimitError;
  return NextResponse.json(
    { error: "plan_limit", metric: e.metric, kind: e.kind, limit: e.limit, used: e.used, upgrade_to: e.upgradeTo, upgrade_url: upgradeUrl(e.upgradeTo), detail: e.message },
    { status: 402 }
  );
}

export type PlanGateSpec = { feature: FeatureKey } | { metric: Metric; increment?: number };

/** One-line route guard: `const gate = await planGate(scope, { metric: "seats" }); if (gate) return gate;` */
export async function planGate(scope: { dataId: string }, spec: PlanGateSpec): Promise<NextResponse | null> {
  try {
    if ("feature" in spec) await assertFeature(scope, spec.feature);
    else await assertWithinLimit(scope, spec.metric, spec.increment ?? 1);
    return null;
  } catch (err) {
    const mapped = planLimitResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}

/** Plan management is owner/admin only on top of the settings area. */
export async function planAdminScope(): Promise<{ ok: true; scope: Scope } | { ok: false; res: NextResponse }> {
  try {
    const scope = await requireScope({ area: "settings", edit: true });
    if (scope.role !== "owner" && scope.role !== "admin") {
      return { ok: false, res: NextResponse.json({ error: "forbidden", detail: "Only owners and admins can manage the plan." }, { status: 403 }) };
    }
    return { ok: true, scope };
  } catch (err) {
    return { ok: false, res: scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
}

/** Map PlanError to its HTTP status. */
export function planErrorResponse(err: unknown, log: string): NextResponse {
  if (err instanceof Error && err.name === "PlanError") {
    const e = err as Error & { code: string; status: number };
    return NextResponse.json({ error: e.code, detail: e.message }, { status: e.status });
  }
  console.error(`[${log}]`, err);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
