import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { llmErrorResponse } from "@/lib/llm-response";
import { runCopilot } from "@/lib/copilot/copilot";
import { COPILOT_MODULES } from "@/lib/copilot/context-builders";

export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.object({
  module: z.enum(COPILOT_MODULES),
  message: z.string().min(1).max(4000),
  recordId: z.string().max(200).optional(),
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

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "bad request", issues: parsed.error.issues.slice(0, 5) }, { status: 400 });
  }

  try {
    const result = await runCopilot(scope.dataId, parsed.data);
    return NextResponse.json(result);
  } catch (err) {
    const mapped = llmErrorResponse(err);
    if (mapped) return mapped;
    console.error("[copilot] failed:", err);
    return NextResponse.json({ error: "Copilot request failed. Please try again." }, { status: 500 });
  }
}
