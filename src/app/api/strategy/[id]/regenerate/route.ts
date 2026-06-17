import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { query, queryOne } from "@/lib/dsql";
import { complete } from "@/lib/llm";
import { buildBusinessContext, getStrategyPrompt } from "@/lib/strategy";

export const maxDuration = 120;
export const runtime = "nodejs";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const { id } = await ctx.params;
  const existing = await queryOne<{ type: string; title: string }>(
    "SELECT type, title FROM strategies WHERE id = $1 AND user_id = $2",
    [id, user.id]
  ).catch(() => null);

  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  const profile = await queryOne(
    "SELECT company_name, industry, product_desc, target_market, stage, geography, challenge, revenue_range FROM business_profile WHERE user_id = $1",
    [user.id]
  ).catch(() => null);

  const ctx2 = buildBusinessContext(profile);
  let content = "";
  try {
    content = await complete(
      [{ role: "user", content: getStrategyPrompt(existing.type, ctx2) }],
      { maxTokens: 2000, retries: 2 }
    );
  } catch (e) {
    content = `# ${existing.title}\n\nRegeneration failed: ${(e as Error).message}`;
  }

  await query("UPDATE strategies SET content = $1, status = 'draft' WHERE id = $2 AND user_id = $3", [content, id, user.id]);
  await query(
    "INSERT INTO strategy_versions (strategy_id, user_id, content) VALUES ($1, $2, $3)",
    [id, user.id, content]
  ).catch(() => {});

  const proposal = await queryOne("SELECT * FROM strategies WHERE id = $1 AND user_id = $2", [id, user.id]);
  return NextResponse.json({ proposal });
}
