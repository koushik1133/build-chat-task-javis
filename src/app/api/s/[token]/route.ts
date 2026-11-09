import { NextRequest, NextResponse } from "next/server";
import { SubmitSchema, SurveyError, loadPublicSurvey, submitSurveyResponse } from "@/lib/engagement/surveys";
import { clientIp, rateLimitAsync, readCappedText } from "@/lib/request-limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ token: string }> };
const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

/** GET /api/s/[token] -> the survey to render. Unknown, forged or expired tokens are all a plain 404. */
export async function GET(req: NextRequest, ctx: Ctx) {
  if (!(await rateLimitAsync(`survey:get:${clientIp(req)}`, 60, 60_000)).allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: NO_STORE });
  try {
    const survey = await loadPublicSurvey((await ctx.params).token);
    return survey ? NextResponse.json({ survey }, { headers: NO_STORE }) : NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  } catch (err) {
    console.error("[survey] GET failed:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500, headers: NO_STORE });
  }
}

/** POST /api/s/[token] { answers, public_ok? } -> one response per request. */
export async function POST(req: NextRequest, ctx: Ctx) {
  if (!(await rateLimitAsync(`survey:post:${clientIp(req)}`, 10, 60_000)).allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: NO_STORE });
  const text = await readCappedText(req, 16_384);
  if (text === null) return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  let json: unknown = null;
  try { json = JSON.parse(text || "null"); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }
  const parsed = SubmitSchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400, headers: NO_STORE });
  try {
    const out = await submitSurveyResponse((await ctx.params).token, parsed.data);
    return NextResponse.json(out, { status: 201, headers: NO_STORE });
  } catch (err) {
    if (err instanceof SurveyError) {
      const status = err.code === "invalid_token" ? 404 : err.code === "already_completed" ? 409 : err.code === "expired" ? 410 : 400;
      return NextResponse.json({ error: err.code, detail: err.message }, { status, headers: NO_STORE });
    }
    console.error("[survey] POST failed:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500, headers: NO_STORE });
  }
}
