import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { query, queryOne } from "@/lib/dsql";
import { completeJson } from "@/lib/llm";
import { llmNotConfiguredResponse } from "@/lib/llm-response";
import { randomUUID } from "crypto";
import { z } from "zod";

const shortList = z.array(z.string().trim().min(1).max(32)).min(1).max(10);

const GenerateBody = z.object({
  platforms: shortList.default(["instagram", "x", "linkedin"]),
  content_types: shortList.default(["post"]),
  count: z.number().int().min(1).max(30).default(7),
  topics: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  auto_schedule: z.boolean().default(true),
  brand_id: z.string().trim().max(64).optional(),
});

/** `YYYY-MM-DD` at 09:00 local, or null when the model emitted an unparseable date. */
function scheduledAtFor(date: unknown): string | null {
  if (typeof date !== "string" || !date.trim()) return null;
  const d = new Date(`${date.trim()}T09:00:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

type GeneratedPost = {
  platform: string;
  content_type: string;
  caption: string;
  hashtags: string;
  image_prompt: string;
  scheduled_date: string; // ISO date string
};

type BrandRow = {
  id: string;
  name: string;
  industry: string;
  products: string;
  tone: string;
  target_audience: string;
  website: string;
};

export async function POST(req: Request) {
  let scope;
  try { scope = await requireScope({ area: "social", edit: true }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const userId = scope.dataId;

  const raw = await req.json().catch(() => null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json({ error: "Request body must be a JSON object." }, { status: 400 });
  }
  const parsed = GenerateBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request.", fieldErrors: parsed.error.flatten().fieldErrors },
      { status: 400 }
    );
  }
  const { brand_id, platforms, content_types, count, topics, auto_schedule } = parsed.data;

  // Fetch brand info
  const brand = brand_id
    ? await queryOne<BrandRow>("SELECT * FROM social_brands WHERE id = $1 AND user_id = $2", [brand_id, userId])
    : await queryOne<BrandRow>("SELECT * FROM social_brands WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1", [userId]);

  if (!brand) {
    return NextResponse.json({ error: "No brand profile found. Please complete Brand Setup first." }, { status: 400 });
  }

  const topicsPrompt = topics.length > 0
    ? `Focus on these topics: ${topics.join(", ")}.`
    : "Research current trends in the industry and use the most relevant topics.";

  const today = new Date();
  const startDate = today.toISOString().split("T")[0];

  const systemPrompt = `You are an expert social media content strategist and copywriter.
Generate ${count} social media posts for a brand. Return ONLY a JSON array.
Each post object must have exactly these keys:
- platform (one of: ${platforms.join(", ")})
- content_type (one of: ${content_types.join(", ")})
- caption (the full post text, compelling and on-brand, NO hashtags in caption)
- hashtags (5-10 relevant hashtags as a space-separated string starting with #)
- image_prompt (a detailed DALL-E prompt describing an image that matches the post)
- scheduled_date (ISO date YYYY-MM-DD, spread posts evenly starting from ${startDate} over the next ${count} days)`;

  const brandContext = `
Brand: ${brand.name}
Industry: ${brand.industry ?? "Technology"}
Products/Services: ${brand.products ?? "Software solutions"}
Tone: ${brand.tone ?? "professional"}
Target audience: ${brand.target_audience ?? "professionals"}
${topicsPrompt}`;

  let posts: GeneratedPost[] | null = null;
  try {
    posts = await completeJson<GeneratedPost[]>(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Generate ${count} varied, high-engagement social media posts for:\n${brandContext}` },
      ],
      `Array<{ platform: string; content_type: string; caption: string; hashtags: string; image_prompt: string; scheduled_date: string }>`
    );
  } catch (err) {
    const notConfigured = llmNotConfiguredResponse(err);
    if (notConfigured) return notConfigured;
    console.error("[social/generate] completion failed:", err);
    return NextResponse.json({ error: "Content generation failed. Please try again." }, { status: 502 });
  }

  if (!Array.isArray(posts)) {
    return NextResponse.json({ error: "Content generation failed. Please try again." }, { status: 502 });
  }

  // Generate image thumbnails via DALL-E if OPENAI_API_KEY is available
  const openaiKey = process.env.OPENAI_API_KEY;

  // Save all generated posts as drafts. Bounded by `count` so a chatty model
  // can't turn one request into an unbounded run of image generations.
  const savedPosts = [];
  for (const post of posts.slice(0, count)) {
    let imageUrl: string | null = null;

    if (openaiKey && post.image_prompt) {
      try {
        const imgRes = await fetch("https://api.openai.com/v1/images/generations", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${openaiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "dall-e-3",
            prompt: post.image_prompt.slice(0, 900),
            n: 1,
            size: "1024x1024",
            quality: "standard",
          }),
        });
        if (imgRes.ok) {
          const imgData = await imgRes.json();
          imageUrl = imgData?.data?.[0]?.url ?? null;
        }
      } catch {
        // Image generation optional — continue without
      }
    }

    const scheduledAt = auto_schedule ? scheduledAtFor(post.scheduled_date) : null;

    const id = randomUUID();
    const [saved] = await query(
      `INSERT INTO social_posts
         (id, user_id, brand_id, platform, content_type, caption, image_url, image_prompt, hashtags, scheduled_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft')
       RETURNING *`,
      [id, userId, brand.id, post.platform, post.content_type, post.caption, imageUrl, post.image_prompt, post.hashtags, scheduledAt]
    );
    if (saved) savedPosts.push(saved);
  }

  return NextResponse.json({ posts: savedPosts, count: savedPosts.length });
}
