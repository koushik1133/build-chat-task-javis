import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { llmErrorResponse } from "@/lib/llm-response";
import { runCopilot } from "@/lib/copilot/copilot";
import { COPILOT_MODULES, COPILOT_PACKS } from "@/lib/copilot/modules";
import { rateLimitAsync } from "@/lib/request-limits";

export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.object({
  module: z.enum(COPILOT_MODULES),
  message: z.string().min(1).max(4000),
  recordId: z.string().max(200).optional(),
  page: z
    .object({
      pathname: z.string().max(300),
      params: z.record(z.string().max(120)).optional(),
      recordType: z.string().max(60).nullable().optional(),
    })
    .strict()
    .optional(),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) }))
    .max(10)
    .optional(),
});

/** POST /api/copilot — one copilot turn for the current page. */
export async function POST(req: Request) {
  let scope;
  try {
    scope = await requireScope({ area: "knowledge", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const rl = await rateLimitAsync(`copilot:${scope.userId}`, 60, 60_000);
  if (!rl.allowed) return NextResponse.json({ error: "Too many copilot requests; try again in a minute." }, { status: 429 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "bad request", issues: parsed.error.issues.slice(0, 5) }, { status: 400 });
  }
  // Keep only params the module pack recognises (defence in depth; the drawer already filters).
  if (parsed.data.page?.params) {
    const allowed = new Set(Object.keys(COPILOT_PACKS[parsed.data.module].entityParams ?? {}).concat("id"));
    parsed.data.page.params = Object.fromEntries(Object.entries(parsed.data.page.params).filter(([k]) => allowed.has(k)));
  }

  try {
    const result = await runCopilot(scope.dataId, parsed.data, { can: scope.can });
    return NextResponse.json(result);
  } catch (err) {
    const mapped = llmErrorResponse(err);
    if (mapped) return mapped;
    console.error("[copilot] failed:", err);
    return NextResponse.json({ error: "Copilot request failed. Please try again." }, { status: 500 });
  }
}
