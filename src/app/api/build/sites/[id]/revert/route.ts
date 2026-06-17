import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/supabase/server";
import { queryOne, query } from "@/lib/dsql";

export const runtime = "nodejs";

const Body = z.object({ revisionId: z.string().uuid() });

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  let user;
  try {
    ({ user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const { id } = await ctx.params;
  const { revisionId } = parsed.data;

  // Verify revision belongs to this site (application-layer integrity)
  const rev = await queryOne<{ html: string; site_id: string }>(
    "SELECT html, site_id FROM site_revisions WHERE id = $1",
    [revisionId]
  );
  if (!rev || rev.site_id !== id) {
    return NextResponse.json({ error: "revision not found" }, { status: 404 });
  }

  await query("UPDATE sites SET html = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3", [
    rev.html,
    id,
    user.id,
  ]);

  return NextResponse.json({ ok: true, html: rev.html });
}
