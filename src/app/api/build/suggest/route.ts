import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { completeJson } from "@/lib/llm";
import { llmNotConfiguredResponse } from "@/lib/llm-response";
import { NICHE_FEATURES_SYS, FEATURE_SUGGESTIONS_SYS } from "@/lib/build-prompts";
import { getCategory } from "@/lib/build-categories";
import { queryOne } from "@/lib/dsql";

export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z.object({ siteId: z.string().uuid() });

type Plan = {
  category?: string;
  themeId?: string;
  niche?: string;
  answers?: Record<string, string>;
  freeText?: string;
};

export async function POST(req: Request) {
  let scope;
  try {
    scope = await requireScope({ area: "sites", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });

  const site = await queryOne<{ plan: string | null; title: string; persona: string | null }>(
    "SELECT plan, title, persona FROM sites WHERE id = $1 AND user_id = $2",
    [parsed.data.siteId, scope.dataId]
  );
  if (!site) return NextResponse.json({ error: "site not found" }, { status: 404 });

  // plan is stored as JSON text in DSQL
  const plan: Plan = site.plan ? JSON.parse(site.plan) : {};
  const categoryId = plan.category ?? site.persona ?? "other";
  const category = getCategory(categoryId);

  if (!category) {
    const brief = `Persona: ${site.persona ?? "unknown"}\nTitle: ${site.title}\nPlan: ${JSON.stringify(plan)}`;
    let result: { features: { title: string; why: string }[] } | null = null;
    try {
      result = await completeJson<{ features: { title: string; why: string }[] }>(
        [{ role: "system", content: FEATURE_SUGGESTIONS_SYS }, { role: "user", content: brief }],
        `{"features":[{"title":string,"why":string}]}`
      );
    } catch (err) {
      const notConfigured = llmNotConfiguredResponse(err);
      if (notConfigured) return notConfigured;
      return NextResponse.json({ headline: "Suggested features", features: [] });
    }
    return NextResponse.json({ headline: "Suggested features for your site", features: result?.features ?? [] });
  }

  const niche = plan.niche || plan.answers?.goal || site.title || category.label;
  const userAnswers = plan.answers
    ? Object.entries(plan.answers).map(([k, v]) => `- ${k}: ${v}`).join("\n")
    : "(no extra answers)";

  const briefForLLM = [
    `CATEGORY: ${category.id} (${category.label})`,
    `NICHE (specific business / focus): ${niche}`,
    "",
    "USER ANSWERS:",
    userAnswers,
    "",
    "CURATED TOP FEATURES:",
    ...category.topFeatures.map((f, i) => `${i + 1}. ${f.title} — ${f.why}`),
  ].join("\n");

  let result: { headline: string; features: { title: string; why: string }[] } | null = null;
  try {
    result = await completeJson<{ headline: string; features: { title: string; why: string }[] }>(
      [{ role: "system", content: NICHE_FEATURES_SYS }, { role: "user", content: briefForLLM }],
      `{"headline":string,"features":[{"title":string,"why":string}]}`
    );
  } catch (err) {
    const notConfigured = llmNotConfiguredResponse(err);
    if (notConfigured) return notConfigured;
    return NextResponse.json({
      headline: `Used by top ${category.label.toLowerCase()} websites today`,
      features: category.topFeatures,
    });
  }

  return NextResponse.json({
    headline: result?.headline || `Used by top ${category.label.toLowerCase()} websites today`,
    features: result?.features ?? category.topFeatures,
  });
}
