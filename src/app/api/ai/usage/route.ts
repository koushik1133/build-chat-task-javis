import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { query, queryOne } from "@/lib/dsql";
import { describeProviders } from "@/lib/llm/providers";
import { getBudget } from "@/lib/llm/budgets";
import { getOrgSettings } from "@/lib/org-settings";

export const dynamic = "force-dynamic";

type NumLike = string | number | null;
const num = (v: NumLike | undefined) => Number(v ?? 0) || 0;

interface TotalsRow {
  calls: NumLike;
  prompt_tokens: NumLike;
  completion_tokens: NumLike;
  cost_micros: NumLike;
}
interface FeatureRow extends TotalsRow { feature: string }
interface ProviderRow extends TotalsRow { provider: string; model: string }
interface TopRunRow { run_id: string; feature: string; calls: NumLike; cost_micros: NumLike; tokens: NumLike; last_at: string | null }
interface DayRow { day: string; calls: NumLike; cost_micros: NumLike }

function monthStartIso(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

export async function GET() {
  let scope;
  try {
    scope = await requireScope({ area: "settings", edit: false });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const since = monthStartIso();
  const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const AGG = `COUNT(*) AS calls,
               COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
               COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
               COALESCE(SUM(cost_micros), 0) AS cost_micros`;

  try {
    const [totals, byFeature, byProvider, days, budget, orgSettings, topRuns] = await Promise.all([
      queryOne<TotalsRow>(
        `SELECT ${AGG} FROM ai_usage WHERE user_id = $1 AND created_at >= $2`,
        [scope.dataId, since]
      ),
      query<FeatureRow>(
        `SELECT feature, ${AGG} FROM ai_usage
         WHERE user_id = $1 AND created_at >= $2
         GROUP BY feature ORDER BY cost_micros DESC LIMIT 20`,
        [scope.dataId, since]
      ),
      query<ProviderRow>(
        `SELECT provider, model, ${AGG} FROM ai_usage
         WHERE user_id = $1 AND created_at >= $2
         GROUP BY provider, model ORDER BY cost_micros DESC LIMIT 20`,
        [scope.dataId, since]
      ),
      query<DayRow>(
        `SELECT to_char(created_at, 'YYYY-MM-DD') AS day, COUNT(*) AS calls,
                COALESCE(SUM(cost_micros), 0) AS cost_micros
         FROM ai_usage WHERE user_id = $1 AND created_at >= $2
         GROUP BY 1 ORDER BY 1 ASC LIMIT 31`,
        [scope.dataId, since30]
      ),
      getBudget(scope.dataId),
      getOrgSettings(scope.dataId),
      query<TopRunRow>(
        `SELECT u.run_id, MAX(u.feature) AS feature, COUNT(*) AS calls, COALESCE(SUM(u.cost_micros), 0) AS cost_micros,
                COALESCE(SUM(u.prompt_tokens + u.completion_tokens), 0) AS tokens, MAX(u.created_at) AS last_at
         FROM ai_usage u WHERE u.user_id = $1 AND u.created_at >= $2 AND u.run_id IS NOT NULL
         GROUP BY u.run_id ORDER BY cost_micros DESC LIMIT 5`,
        [scope.dataId, since]
      ).catch(() => [] as TopRunRow[]),
    ]);

    // Dense 30-day series so the bar strip always has 30 slots.
    const byDay = new Map(days.map((d) => [d.day, d]));
    const series: { date: string; calls: number; costMicros: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const date = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      const row = byDay.get(date);
      series.push({ date, calls: num(row?.calls), costMicros: num(row?.cost_micros) });
    }

    return NextResponse.json({
      since,
      currency: orgSettings.currency,
      totals: {
        calls: num(totals?.calls),
        promptTokens: num(totals?.prompt_tokens),
        completionTokens: num(totals?.completion_tokens),
        costMicros: num(totals?.cost_micros),
      },
      byFeature: byFeature.map((r) => ({
        feature: r.feature,
        calls: num(r.calls),
        promptTokens: num(r.prompt_tokens),
        completionTokens: num(r.completion_tokens),
        costMicros: num(r.cost_micros),
      })),
      byProvider: byProvider.map((r) => ({
        provider: r.provider,
        model: r.model,
        calls: num(r.calls),
        promptTokens: num(r.prompt_tokens),
        completionTokens: num(r.completion_tokens),
        costMicros: num(r.cost_micros),
      })),
      series,
      topRuns: topRuns.map((r) => ({ runId: r.run_id, feature: r.feature, calls: num(r.calls), costMicros: num(r.cost_micros), tokens: num(r.tokens), lastAt: r.last_at })),
      budget,
      providers: describeProviders(),
    });
  } catch (err) {
    console.error("[ai/usage] failed:", err);
    return NextResponse.json({ error: "Could not load AI usage." }, { status: 500 });
  }
}
