import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { queryOne, query } from "@/lib/dsql";

export const runtime = "nodejs";

const Body = z.object({
  siteId: z.string().uuid(),
  html: z.string().min(20).max(500_000),
});

export async function POST(req: Request) {
  let scope;
  try {
    scope = await requireScope({ area: "sites", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const { siteId, html } = parsed.data;

  if (!html.toLowerCase().includes("<!doctype")) {
    return NextResponse.json({ error: "invalid html" }, { status: 400 });
  }

  const site = await queryOne("SELECT id FROM sites WHERE id = $1 AND user_id = $2", [siteId, scope.dataId]);
  if (!site) return NextResponse.json({ error: "site not found" }, { status: 404 });

  await query("UPDATE sites SET html = $1, updated_at = NOW() WHERE id = $2", [html, siteId]);

  await query(
    `INSERT INTO site_revisions (site_id, user_id, source, prompt, html)
     VALUES ($1, $2, 'manual', 'inline edit', $3)`,
    [siteId, scope.dataId, html]
  );

  return NextResponse.json({ ok: true });
}
