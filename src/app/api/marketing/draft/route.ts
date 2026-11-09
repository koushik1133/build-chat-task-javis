import { NextResponse, type NextRequest } from "next/server";
import { parseBody } from "@/lib/money/http";
import { rateLimitAsync } from "@/lib/request-limits";
import { isLlmConfigured } from "@/lib/llm";
import { meteredComplete } from "@/lib/llm/metering";
import { llmErrorResponse } from "@/lib/llm-response";
import { parseModelJson } from "@/lib/model-json";
import { getAudience } from "@/lib/marketing/audiences";
import { marketingError, marketingScope } from "@/lib/marketing/http";
import { ensureUnsubscribe } from "@/lib/marketing/render";
import { DraftSchema } from "@/lib/marketing/schemas";
import { describeAudience, parseAudienceDefinition } from "@/lib/marketing/types";
import { getBranding } from "@/lib/branding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/marketing/draft { goal, channel, audience_id?, tone? } → { subject, preheader, body_md }.
 * 503 when no LLM provider is configured. Nothing is saved.
 */
export async function POST(req: NextRequest) {
  const s = await marketingScope(true);
  if (!s.ok) return s.res;
  if (!isLlmConfigured()) return NextResponse.json({ error: "llm_not_configured", detail: "No AI provider is configured. Add a model key under Settings → AI." }, { status: 503 });
  if (!(await rateLimitAsync(`marketing:draft:${s.scope.userId}`, 20, 60_000)).allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const body = await parseBody(req, DraftSchema, 8_000);
  if (!body.ok) return body.res;
  try {
    const audience = body.data.audience_id ? await getAudience(s.scope.dataId, body.data.audience_id) : null;
    const branding = await getBranding(s.scope.dataId).catch(() => null);
    const isSms = body.data.channel === "sms";
    const text = await meteredComplete(
      s.scope.dataId,
      "generate",
      [
        {
          role: "system",
          content:
            `You write ${isSms ? "short SMS marketing messages (max 300 characters, plain text, no markdown)" : "marketing emails as GitHub-flavoured markdown (short paragraphs, one clear call to action)"} for a business. ` +
            "Personalise with the merge fields {{first_name}}, {{company}} and {{org_name}} where natural. " +
            (isSms ? "" : "Always end with a line containing {{unsubscribe_url}} as a markdown link. ") +
            'Never invent prices, dates or offers that are not in the goal. Return ONLY JSON: {"subject": string, "preheader": string, "body_md": string}.',
        },
        {
          role: "user",
          content: `Business: ${branding?.brand_name ?? "our business"}\nChannel: ${body.data.channel}\nTone: ${body.data.tone ?? "friendly"}\nAudience: ${audience ? `${audience.name} (${describeAudience(parseAudienceDefinition(audience.definition))})` : "all contacts"}\n\nGoal:\n${body.data.goal}`,
        },
      ],
      { maxTokens: 1200, temperature: 0.6 }
    );
    const parsed = parseModelJson<{ subject?: unknown; preheader?: unknown; body_md?: unknown }>(text);
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    let body_md = str(parsed?.body_md) || text.replace(/^```(?:json|markdown|md)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    if (!body_md) return NextResponse.json({ error: "empty_draft", detail: "The model returned nothing; try again with more detail." }, { status: 502 });
    if (!isSms) body_md = ensureUnsubscribe(body_md);
    return NextResponse.json({ subject: str(parsed?.subject).slice(0, 200), preheader: str(parsed?.preheader).slice(0, 200), body_md: body_md.slice(0, 20_000) });
  } catch (err) {
    return llmErrorResponse(err) ?? marketingError(err, "marketing/draft");
  }
}
