import { NextResponse, type NextRequest } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { rateLimitAsync } from "@/lib/request-limits";
import { errorResponse, parseBody } from "@/lib/money/http";
import { isLlmConfigured } from "@/lib/llm";
import { meteredComplete } from "@/lib/llm/metering";
import { mergeDefaults } from "@/lib/documents/documents";
import { getTemplate } from "@/lib/documents/templates";
import { findStarter } from "@/lib/documents/starters";
import { DraftRequestSchema } from "@/lib/documents/schemas";
import { extractMergeKeys } from "@/lib/documents/render";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/documents/draft — AI-draft a markdown body from a template
 * skeleton (the org template, or the built-in starter of that kind) plus the
 * user's instructions. Returns `{ body_md, merge_keys }`; nothing is saved.
 * 503 when no LLM provider is configured.
 */
export async function POST(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "crm", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isLlmConfigured()) return NextResponse.json({ error: "llm_unavailable", detail: "No AI provider is configured. Add a model key under Settings → AI." }, { status: 503 });
  if (!(await rateLimitAsync(`documents:draft:${scope.userId}`, 20, 60_000)).allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const body = await parseBody(req, DraftRequestSchema, 16_384);
  if (!body.ok) return body.res;
  try {
    const template = body.data.template_id ? await getTemplate(scope.dataId, body.data.template_id) : null;
    const skeleton = template?.body_md ?? findStarter(body.data.kind === "nda" ? "nda" : body.data.kind === "proposal" ? "proposal" : body.data.kind === "form" ? "consent-form" : body.data.kind === "letter" ? "engagement-letter" : "service-agreement")?.body_md ?? "";
    const defaults = await mergeDefaults(scope.dataId, body.data.contact_id);
    const context = Object.entries(defaults)
      .filter(([, v]) => v)
      .map(([k, v]) => `- {{${k}}} → ${v}`)
      .join("\n");
    const text = await meteredComplete(
      scope.dataId,
      "generate",
      [
        {
          role: "system",
          content:
            "You draft business documents as GitHub-flavoured markdown (headings with #, paragraphs, - bullet lists, **bold**, simple | tables |). " +
            "Keep {{merge.fields}} exactly as written where the value should be filled at send time; never invent legal citations. " +
            "Return only the markdown body — no preamble, no code fences.",
        },
        {
          role: "user",
          content: `Document kind: ${body.data.kind}\n\nInstructions:\n${body.data.instructions}\n\nAvailable merge fields (keep these placeholders where they fit):\n${context || "(none)"}\n\nStarting skeleton to adapt:\n\n${skeleton.slice(0, 12_000)}`,
        },
      ],
      { maxTokens: 2500, temperature: 0.4 }
    );
    const body_md = text.replace(/^```(?:markdown|md)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    if (!body_md) return NextResponse.json({ error: "empty_draft", detail: "The model returned nothing; try again with more detail." }, { status: 502 });
    return NextResponse.json({ body_md, merge_keys: extractMergeKeys(body_md) });
  } catch (err) {
    if (err instanceof Error && err.name === "LlmNotConfiguredError") return NextResponse.json({ error: "llm_unavailable", detail: err.message }, { status: 503 });
    return errorResponse(err, "documents.draft");
  }
}
