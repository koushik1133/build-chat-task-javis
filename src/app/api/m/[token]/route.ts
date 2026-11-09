import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { rateLimitAsync } from "@/lib/request-limits";
import { parseBody } from "@/lib/money/http";
import { CrewActionError, getCrewDay, resolveCrewToken, runCrewAction } from "@/lib/crew";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ token: string }> };

function ip(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "anon";
}

const NO_STORE = { "Cache-Control": "no-store" };

/** GET /api/m/[token]?tz= — today's tasks and bookings for the crew link. */
export async function GET(req: NextRequest, ctx: Ctx) {
  if (!(await rateLimitAsync(`crew:${ip(req)}`, 120, 60_000)).allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  try {
    const { token } = await ctx.params;
    const t = await resolveCrewToken(token);
    if (!t) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    const day = await getCrewDay(t, req.nextUrl.searchParams.get("tz"));
    return NextResponse.json(day, { headers: NO_STORE });
  } catch (err) {
    console.error("[crew] GET failed:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

const ActionBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("complete_task"), taskId: z.string().min(1).max(64), done: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("add_note"), note: z.string().min(1).max(2000), bookingId: z.string().max(64).nullable().optional() }).strict(),
  z.object({ action: z.literal("clock_in") }).strict(),
  z.object({ action: z.literal("clock_out") }).strict(),
]);

/** POST /api/m/[token] — {action: complete_task|add_note|clock_in|clock_out} */
export async function POST(req: NextRequest, ctx: Ctx) {
  if (!(await rateLimitAsync(`crew:${ip(req)}`, 120, 60_000)).allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const { token } = await ctx.params;
  const t = await resolveCrewToken(token).catch(() => null);
  if (!t) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  const parsed = await parseBody(req, ActionBody, 8_192);
  if (!parsed.ok) return parsed.res;
  try {
    const result = await runCrewAction(t, parsed.data);
    return NextResponse.json({ ok: true, ...result }, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof CrewActionError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error("[crew] POST failed:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
