import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/supabase/server";
import { complete } from "@/lib/llm";
import {
  SITE_GENERATION_SYS,
  buildBriefFromPlan,
  deriveNiche,
  type SitePlan,
} from "@/lib/build-prompts";
import { getCategory, getTheme } from "@/lib/build-categories";

export const runtime = "nodejs";
export const maxDuration = 90;

const Body = z.object({
  category: z.string().min(1).max(40),
  themeId: z.string().min(1).max(60),
  answers: z.record(z.string()),
  freeText: z.string().max(2000).optional(),
  resumeProfile: z.record(z.unknown()).optional(),
});

export async function POST(req: Request) {
  let supabase, user;
  try {
    ({ supabase, user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "bad request", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { category: categoryId, themeId, answers, freeText, resumeProfile } = parsed.data;

  const category = getCategory(categoryId);
  const theme = getTheme(categoryId, themeId);
  if (!category || !theme) {
    return NextResponse.json({ error: "unknown category or theme" }, { status: 400 });
  }

  const niche = deriveNiche(answers, freeText);
  const plan: SitePlan = {
    category: categoryId,
    themeId,
    niche,
    answers,
    freeText,
    resumeProfile,
  };
  const brief = buildBriefFromPlan(plan, category, theme);

  let html: string;
  try {
    html = await complete([
      { role: "system", content: SITE_GENERATION_SYS },
      { role: "user", content: brief },
    ]);
  } catch (e) {
    console.error("[generate] LLM call failed:", e);
    return NextResponse.json(
      { error: "LLM call failed: " + (e as Error).message },
      { status: 502 }
    );
  }

  const cleaned = stripFences(html);
  if (!cleaned.toLowerCase().includes("<!doctype")) {
    return NextResponse.json(
      { error: "model returned invalid HTML", preview: cleaned.slice(0, 200) },
      { status: 502 }
    );
  }

  const title = deriveTitle(answers.businessName || answers.goal || category.label);

  const siteId = crypto.randomUUID();
  const scriptTag = `\n<script>
  window.JAVIS_SITE_ID = "${siteId}";
  window.JAVIS_API_URL = "${process.env.NEXT_PUBLIC_APP_URL || ''}";
  
  // Analytics Tracker
  if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    fetch(window.JAVIS_API_URL + '/api/analytics/' + window.JAVIS_SITE_ID, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: window.location.pathname })
    }).catch(() => {});
  }
</script>\n`;
  let finalHtml = cleaned;
  if (finalHtml.includes('</head>')) {
    finalHtml = finalHtml.replace('</head>', `${scriptTag}</head>`);
  } else {
    finalHtml += scriptTag;
  }

  const { data: site, error } = await supabase
    .from("sites")
    .insert({
      id: siteId,
      user_id: user.id,
      title,
      persona: categoryId,
      plan,
      html: finalHtml,
    })
    .select("id")
    .single();
  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });

  await supabase.from("site_revisions").insert({
    site_id: site.id,
    user_id: user.id,
    source: "initial",
    prompt: brief,
    html: finalHtml,
  });

  return NextResponse.json({ siteId: site.id });
}

function stripFences(s: string) {
  return s
    .replace(/^```(?:html)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function deriveTitle(input: string) {
  const first = input.split(/[.!?\n]/)[0]?.trim() ?? "";
  return first.slice(0, 60) || "Untitled site";
}
