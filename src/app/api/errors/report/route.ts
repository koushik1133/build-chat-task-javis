import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/lib/auth/scope";
import { parseBody } from "@/lib/money/http";
import { clientIp, rateLimitAsync } from "@/lib/request-limits";
import { captureError } from "@/lib/errors/capture";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Client error boundaries post here. Anonymous allowed; everything is capped
 * and rate-limited per IP AND globally (the per-IP bucket alone would let a
 * proxy pool grow `app_errors` without bound). Signed-in reports are filed
 * under the caller's workspace data id so the System health page can show
 * them; anonymous reports are stored unattributed and never rendered.
 */
const GLOBAL_LIMIT = { limit: 600, windowMs: 60_000 } as const;

const Body = z
  .object({
    message: z.string().trim().min(1).max(2_000),
    stack: z.string().max(4_000).optional(),
    route: z.string().trim().min(1).max(300),
    digest: z.string().max(100).optional(),
  })
  .strict();

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const limit = await rateLimitAsync(`errors-report:${ip}`, 20, 60_000);
  if (!limit.allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const global = await rateLimitAsync("errors-report:global", GLOBAL_LIMIT);
  if (!global.allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const parsed = await parseBody(req, Body, 8_192);
  if (!parsed.ok) return parsed.res;

  // Attribute to the workspace (data id), not the actor, so a member's report lands on the org's health page.
  let userId: string | null = null;
  try {
    userId = (await requireScope({})).dataId;
  } catch {
    userId = null;
  }

  const err = new Error(parsed.data.message);
  err.stack = parsed.data.stack ?? `${parsed.data.message}${parsed.data.digest ? `\n(digest ${parsed.data.digest})` : ""}`;
  const id = await captureError(err, { route: `client:${parsed.data.route}`, method: "CLIENT", status: null, userId });
  return NextResponse.json({ id }, { status: id ? 201 : 202 });
}
