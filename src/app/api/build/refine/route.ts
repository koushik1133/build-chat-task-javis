import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/supabase/server";
import { complete } from "@/lib/llm";
import { SITE_REFINE_SYS } from "@/lib/build-prompts";
import { queryOne, query } from "@/lib/dsql";

export const runtime = "nodejs";
export const maxDuration = 90;

const Body = z.object({
  siteId: z.string().uuid(),
  instruction: z.string().min(1).max(800),
  source: z.enum(["refine", "feature", "manual"]).default("refine"),
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
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const { siteId, instruction, source } = parsed.data;

  const site = await queryOne<{ id: string; html: string }>(
    "SELECT id, html FROM sites WHERE id = $1 AND user_id = $2",
    [siteId, user.id]
  );
  if (!site) return NextResponse.json({ error: "site not found" }, { status: 404 });

  let updated: string;
  try {
    updated = await complete(
      [
        { role: "system", content: SITE_REFINE_SYS },
        { role: "user", content: `User instruction:\n${instruction}\n\nCurrent HTML:\n${site.html.slice(0, 8000)}` },
      ],
      { maxTokens: 8000 }
    );
  } catch (e) {
    return NextResponse.json(
      { error: "AI call failed: " + (e as Error).message },
      { status: 502 }
    );
  }

  const cleaned = stripFences(updated);
  if (!cleaned.toLowerCase().includes("<!doctype")) {
    return NextResponse.json({ error: "model returned invalid HTML" }, { status: 502 });
  }

  let finalHtml = cleaned;
  if (!finalHtml.includes("window.JAVIS_SITE_ID")) {
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
    finalHtml = finalHtml.includes("</head>")
      ? finalHtml.replace("</head>", `${scriptTag}</head>`)
      : finalHtml + scriptTag;
  }

  await query(
    "UPDATE sites SET html = $1, updated_at = NOW() WHERE id = $2",
    [finalHtml, siteId]
  );

  await query(
    `INSERT INTO site_revisions (site_id, user_id, source, prompt, html)
     VALUES ($1, $2, $3, $4, $5)`,
    [siteId, user.id, source, instruction, finalHtml]
  );

  return NextResponse.json({ ok: true });
}

function stripFences(s: string) {
  return s.replace(/^```(?:html)?\s*/i, "").replace(/```\s*$/i, "").trim();
}
