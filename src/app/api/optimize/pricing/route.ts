import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { dbUnavailableResponse } from "@/lib/api-db";
import { parseBody } from "@/lib/money/http";
import { runPricing } from "@/lib/optimize";
import { respondWithNarrative } from "@/lib/optimize/http";

export const dynamic = "force-dynamic";

const Body = z
  .object({
    items: z
      .array(
        z.object({
          description: z.string().trim().min(1).max(500),
          qty: z.number().finite().min(0).max(1_000_000).default(1),
          unit_minor: z.number().int().min(0).max(1_000_000_000_000),
        })
      )
      .min(1)
      .max(50),
    narrate: z.boolean().optional(),
  })
  .strict();

/** POST /api/optimize/pricing {items:[{description, qty, unit_minor}], narrate?} */
export async function POST(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "billing" });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = await parseBody(req, Body, 32_000);
  if (!parsed.ok) return parsed.res;
  try {
    const suggestion = await runPricing(scope.dataId, parsed.data.items);
    return respondWithNarrative(scope.dataId, "pricing", "suggestion", suggestion, parsed.data.narrate === true);
  } catch (err) {
    return dbUnavailableResponse(err, "optimize/pricing");
  }
}
