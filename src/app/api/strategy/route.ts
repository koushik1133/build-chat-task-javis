import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { query, queryOne } from "@/lib/dsql";
import { complete, LlmNotConfiguredError } from "@/lib/llm";
import { llmNotConfiguredResponse } from "@/lib/llm-response";
import {
  buildBusinessContext,
  getStrategyPrompt,
  defaultTitle,
  type BusinessContext,
} from "@/lib/strategy";

export const maxDuration = 120;
export const runtime = "nodejs";

async function loadProfile(userId: string): Promise<BusinessContext | null> {
  return queryOne<BusinessContext>(
    "SELECT company_name, industry, product_desc, target_market, stage, geography, challenge, revenue_range FROM business_profile WHERE user_id = $1",
    [userId]
  ).catch(() => null);
}

async function generateStrategy(
  userId: string,
  opts: { type: string; title?: string; custom_context?: Partial<BusinessContext> }
) {
  const profile = await loadProfile(userId);
  const ctx = buildBusinessContext(profile, opts.custom_context);
  const type = opts.type || "growth";
  const title = opts.title?.trim() || defaultTitle(type as never, ctx.company_name);

  let content = "";
  try {
    content = await complete(
      [{ role: "user", content: getStrategyPrompt(type, ctx) }],
      { maxTokens: 2000, retries: 2 }
    );
  } catch (err) {
    if (err instanceof LlmNotConfiguredError) throw err;
    console.error("[strategy] LLM call failed:", err);
    content = `# ${title}\n\nGeneration failed. Please try again.`;
  }

  const proposal = await queryOne(
    `INSERT INTO strategies (user_id, title, type, content, status)
     VALUES ($1, $2, $3, $4, 'draft') RETURNING *`,
    [userId, title, type, content]
  );

  if (!proposal) return null;

  await query(
    `INSERT INTO strategy_versions (strategy_id, user_id, content) VALUES ($1, $2, $3)`,
    [(proposal as { id: string }).id, userId, content]
  ).catch(() => {});

  return proposal;
}

export async function GET() {
  let scope;
  try { scope = await requireScope({ area: "knowledge", edit: false }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const [proposals, profile] = await Promise.all([
    query(
      "SELECT id, title, type, status, created_at FROM strategies WHERE user_id = $1 ORDER BY created_at DESC",
      [scope.dataId]
    ).catch(() => []),
    loadProfile(scope.dataId),
  ]);

  return NextResponse.json({ proposals, profile });
}

export async function POST(req: Request) {
  let scope;
  try { scope = await requireScope({ area: "knowledge", edit: true }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const rawBody = await req.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const { type, title, custom_context } = rawBody;
  try {
    const proposal = await generateStrategy(scope.dataId, { type, title, custom_context });

    if (!proposal) {
      return NextResponse.json({ error: "Failed to save strategy" }, { status: 500 });
    }

    return NextResponse.json({ proposal });
  } catch (err) {
    const notConfigured = llmNotConfiguredResponse(err);
    if (notConfigured) return notConfigured;
    console.error("[strategy] POST error:", err);
    return NextResponse.json({ error: "Failed to generate strategy" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  let scope;
  try { scope = await requireScope({ area: "knowledge", edit: true }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const rawBody = await req.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const { id, status, content, title } = rawBody;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  if (title?.trim()) {
    await query("UPDATE strategies SET title = $1 WHERE id = $2 AND user_id = $3", [title.trim(), id, scope.dataId]);
  }
  if (status) {
    await query("UPDATE strategies SET status = $1 WHERE id = $2 AND user_id = $3", [status, id, scope.dataId]);
  }
  if (content !== undefined) {
    await query("UPDATE strategies SET content = $1 WHERE id = $2 AND user_id = $3", [content, id, scope.dataId]);
    await query(
      "INSERT INTO strategy_versions (strategy_id, user_id, content) VALUES ($1, $2, $3)",
      [id, scope.dataId, content]
    ).catch(() => {});
  }

  const proposal = await queryOne("SELECT * FROM strategies WHERE id = $1 AND user_id = $2", [id, scope.dataId]);
  return NextResponse.json({ ok: true, proposal });
}

export async function DELETE(req: Request) {
  let scope;
  try { scope = await requireScope({ area: "knowledge", edit: true }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const rawBody = await req.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const { id } = rawBody;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  await query("DELETE FROM strategy_versions WHERE strategy_id = $1 AND user_id = $2", [id, scope.dataId]).catch(() => {});
  await query("DELETE FROM strategies WHERE id = $1 AND user_id = $2", [id, scope.dataId]);
  return NextResponse.json({ ok: true });
}
