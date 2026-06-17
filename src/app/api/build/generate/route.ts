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
import { query, queryOne } from "@/lib/dsql";

export const runtime = "nodejs";
export const maxDuration = 90;

const Body = z.object({
  category: z.string().min(1).max(40),
  themeId: z.string().min(1).max(60),
  answers: z.record(z.string()),
  freeText: z.string().max(2000).optional(),
  resumeProfile: z.record(z.unknown()).optional(),
  businessProfile: z.record(z.unknown()).optional(),
});

export async function POST(req: Request) {
  let user;
  try {
    ({ user } = await requireUser());
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
  const { category: categoryId, themeId, answers, freeText, resumeProfile, businessProfile } = parsed.data;

  const category = getCategory(categoryId);
  const theme = getTheme(categoryId, themeId);
  if (!category || !theme) {
    return NextResponse.json({ error: "unknown category or theme" }, { status: 400 });
  }

  // Also fetch business profile from DB as fallback context
  let resolvedProfile = businessProfile;
  if (!resolvedProfile) {
    const dbProfile = await queryOne(
      "SELECT * FROM business_profile WHERE user_id = $1",
      [user.id]
    ).catch(() => null);
    if (dbProfile) resolvedProfile = dbProfile as Record<string, unknown>;
  }

  const niche = deriveNiche(answers, freeText);
  const plan: SitePlan = { category: categoryId, themeId, niche, answers, freeText, resumeProfile, businessProfile: resolvedProfile };
  const brief = buildBriefFromPlan(plan, category, theme);

  let html: string;
  try {
    html = await complete(
      [
        { role: "system", content: SITE_GENERATION_SYS },
        { role: "user", content: brief },
      ],
      { maxTokens: 8000 }
    );
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
  if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    fetch(window.JAVIS_API_URL + '/api/analytics/' + window.JAVIS_SITE_ID, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: window.location.pathname })
    }).catch(() => {});
  }
</script>\n`;
  let finalHtml = cleaned;
  finalHtml = finalHtml.includes("</head>")
    ? finalHtml.replace("</head>", `${scriptTag}</head>`)
    : finalHtml + scriptTag;

  // Insert into Aurora DSQL — plan stored as JSON string (DSQL stores JSON as TEXT)
  const site = await queryOne<{ id: string }>(
    `INSERT INTO sites (id, user_id, title, persona, plan, html)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [siteId, user.id, title, categoryId, JSON.stringify(plan), finalHtml]
  );
  if (!site) return NextResponse.json({ error: "insert failed" }, { status: 500 });

  await query(
    `INSERT INTO site_revisions (site_id, user_id, source, prompt, html)
     VALUES ($1, $2, 'initial', $3, $4)`,
    [siteId, user.id, brief, finalHtml]
  );

  return NextResponse.json({ siteId: site.id });
}

function stripFences(s: string) {
  return s.replace(/^```(?:html)?\s*/i, "").replace(/```\s*$/i, "").trim();
}

function deriveTitle(input: string) {
  const first = input.split(/[.!?\n]/)[0]?.trim() ?? "";
  return first.slice(0, 60) || "Untitled site";
}
