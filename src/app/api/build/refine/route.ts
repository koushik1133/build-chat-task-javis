import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/supabase/server";
import { complete } from "@/lib/llm";
import { SITE_REFINE_SYS } from "@/lib/build-prompts";

export const runtime = "nodejs";
export const maxDuration = 90;

const Body = z.object({
  siteId: z.string().uuid(),
  instruction: z.string().min(1).max(800),
  source: z.enum(["refine", "feature", "manual"]).default("refine"),
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
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const { siteId, instruction, source } = parsed.data;

  const { data: site, error: gErr } = await supabase
    .from("sites")
    .select("id,html")
    .eq("id", siteId)
    .single();
  if (gErr || !site)
    return NextResponse.json({ error: "site not found" }, { status: 404 });

  const updated = await complete([
    { role: "system", content: SITE_REFINE_SYS },
    {
      role: "user",
      content: `User instruction:\n${instruction}\n\nCurrent HTML:\n${site.html}`,
    },
  ]);

  const cleaned = stripFences(updated);
  if (!cleaned.toLowerCase().includes("<!doctype")) {
    return NextResponse.json(
      { error: "model returned invalid HTML" },
      { status: 502 }
    );
  }

  let finalHtml = cleaned;
  if (!finalHtml.includes('window.JAVIS_SITE_ID')) {
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
    if (finalHtml.includes('</head>')) {
      finalHtml = finalHtml.replace('</head>', `${scriptTag}</head>`);
    } else {
      finalHtml += scriptTag;
    }
  }

  const { error: uErr } = await supabase
    .from("sites")
    .update({ html: finalHtml, updated_at: new Date().toISOString() })
    .eq("id", siteId);
  if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 });

  await supabase.from("site_revisions").insert({
    site_id: siteId,
    user_id: user.id,
    source,
    prompt: instruction,
    html: finalHtml,
  });

  return NextResponse.json({ ok: true });
}

function stripFences(s: string) {
  return s
    .replace(/^```(?:html)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}
