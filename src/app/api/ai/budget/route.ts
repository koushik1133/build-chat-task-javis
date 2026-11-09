import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { getBudget, setBudget } from "@/lib/llm/budgets";
import { usdToMicros } from "@/lib/llm/pricing";

export const dynamic = "force-dynamic";

export async function GET() {
  let scope;
  try {
    scope = await requireScope({ area: "settings", edit: false });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ budget: await getBudget(scope.dataId) });
  } catch (err) {
    console.error("[ai/budget] get failed:", err);
    return NextResponse.json({ error: "Could not load AI budget." }, { status: 500 });
  }
}

const FEATURES = ["agent", "copilot", "chat", "playbook", "receptionist", "generate", "other"] as const;

const Patch = z
  .object({
    capUsd: z.number().min(0).max(10_000).nullable().optional(),
    hardStop: z.boolean().optional(),
    allowlist: z.array(z.string().min(1).max(64)).max(50).nullable().optional(),
    dailyCapUsd: z.number().min(0).max(10_000).nullable().optional(),
    /** Monthly cap per feature in USD; omitted features are uncapped. */
    featureCapsUsd: z.record(z.enum(FEATURES), z.number().min(0).max(10_000)).nullable().optional(),
    maxTokensPerCall: z.number().int().min(100).max(32_000).nullable().optional(),
    fallbackModel: z.string().trim().min(1).max(80).nullable().optional(),
  })
  .strict();

export async function PATCH(req: Request) {
  let scope;
  try {
    scope = await requireScope({ area: "settings", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const { capUsd, hardStop, allowlist, dailyCapUsd, featureCapsUsd, maxTokensPerCall, fallbackModel } = parsed.data;

  try {
    await setBudget(scope.dataId, {
      ...(capUsd !== undefined ? { capMicros: capUsd === null ? null : usdToMicros(capUsd) } : {}),
      ...(hardStop !== undefined ? { hardStop } : {}),
      ...(allowlist !== undefined ? { allowlist: allowlist === null ? null : allowlist } : {}),
      ...(dailyCapUsd !== undefined ? { dailyCapMicros: dailyCapUsd === null ? null : usdToMicros(dailyCapUsd) } : {}),
      ...(featureCapsUsd !== undefined
        ? { featureCaps: featureCapsUsd === null ? null : Object.fromEntries(Object.entries(featureCapsUsd).map(([k, v]) => [k, usdToMicros(v as number)])) }
        : {}),
      ...(maxTokensPerCall !== undefined ? { maxTokensPerCall } : {}),
      ...(fallbackModel !== undefined ? { fallbackModel } : {}),
    });
    return NextResponse.json({ budget: await getBudget(scope.dataId) });
  } catch (err) {
    console.error("[ai/budget] patch failed:", err);
    return NextResponse.json({ error: "Could not save AI budget." }, { status: 500 });
  }
}
