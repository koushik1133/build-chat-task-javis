import { NextResponse, type NextRequest } from "next/server";
import { parseBody } from "@/lib/money/http";
import { rateLimitAsync } from "@/lib/request-limits";
import { countAudience, eligibleCount, resolveAudience } from "@/lib/marketing/audiences";
import { marketingError, marketingScope } from "@/lib/marketing/http";
import { AudiencePreviewSchema, PreviewSchema } from "@/lib/marketing/schemas";
import { renderEmail, renderSms, SAMPLE_VARS } from "@/lib/marketing/render";
import { loadContact, mergeVarsFor } from "@/lib/marketing/send";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/marketing/preview
 *   { definition, channel? }         → live audience count + eligible count + sample (builder)
 *   { body_md, subject?, channel, contact_id? } → rendered content with a sample / real contact (composer)
 */
export async function POST(req: NextRequest) {
  const s = await marketingScope(false);
  if (!s.ok) return s.res;
  if (!(await rateLimitAsync(`marketing:preview:${s.scope.userId}`, 120, 60_000)).allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const raw = await req.clone().json().catch(() => null);
  const isContent = raw && typeof raw === "object" && "body_md" in (raw as Record<string, unknown>);
  try {
    if (isContent) {
      const body = await parseBody(req, PreviewSchema, 80_000);
      if (!body.ok) return body.res;
      const contact = body.data.contact_id ? await loadContact(s.scope.dataId, body.data.contact_id) : null;
      const vars = contact ? await mergeVarsFor(s.scope.dataId, contact, SAMPLE_VARS.unsubscribe_url ?? "") : SAMPLE_VARS;
      if (body.data.channel === "sms") return NextResponse.json({ channel: "sms", text: renderSms(body.data.body_md, vars), vars });
      const r = renderEmail({ subject: body.data.subject ?? "", preheader: body.data.preheader, body_md: body.data.body_md, vars });
      return NextResponse.json({ channel: "email", subject: r.subject, html: r.html, text: r.text, vars });
    }
    const body = await parseBody(req, AudiencePreviewSchema, 32_000);
    if (!body.ok) return body.res;
    const channel = body.data.channel ?? "email";
    const [count, eligible, sample] = await Promise.all([
      countAudience(s.scope.dataId, body.data.definition),
      eligibleCount(s.scope.dataId, body.data.definition, channel),
      resolveAudience(s.scope.dataId, body.data.definition, { limit: body.data.limit ?? 8 }),
    ]);
    return NextResponse.json({ count, eligible: eligible.eligible, channel, sample });
  } catch (err) {
    return marketingError(err, "marketing/preview");
  }
}
