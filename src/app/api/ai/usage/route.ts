import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { query, queryOne } from "@/lib/dsql";
import { describeProviders } from "@/lib/llm/providers";
import { getBudget } from "@/lib/llm/budgets";

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
interface DayRow { day: string; calls: NumLike; cost_micros: NumLike }

function monthStartIso(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

export async function GET() {
  let user;
  try {
    ({ user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const since = monthStartIso();
  const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const AGG = `COUNT(*) AS calls,
               COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
               COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
               COALESCE(SUM(cost_micros), 0) AS cost_micros`;

  try {
    const [totals, byFeature, byProvider, days, budget] = await Promise.all([
      queryOne<TotalsRow>(
        `SELECT ${AGG} FROM ai_usage WHERE user_id = $1 AND created_at >= $2`,
        [user.id, since]
      ),
      query<FeatureRow>(
        `SELECT feature, ${AGG} FROM ai_usage
         WHERE user_id = $1 AND created_at >= $2
         GROUP BY feature ORDER BY cost_micros DESC LIMIT 20`,
        [user.id, since]
      ),
      query<ProviderRow>(
        `SELECT provider, model, ${AGG} FROM ai_usage
         WHERE user_id = $1 AND created_at >= $2
         GROUP BY provider, model ORDER BY cost_micros DESC LIMIT 20`,
        [user.id, since]
      ),
      query<DayRow>(
        `SELECT to_char(created_at, 'YYYY-MM-DD') AS day, COUNT(*) AS calls,
                COALESCE(SUM(cost_micros), 0) AS cost_micros
         FROM ai_usage WHERE user_id = $1 AND created_at >= $2
         GROUP BY 1 ORDER BY 1 ASC LIMIT 31`,
        [user.id, since30]
      ),
      getBudget(user.id),
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
      budget,
      providers: describeProviders(),
    });
  } catch (err) {
    console.error("[ai/usage] failed:", err);
    return NextResponse.json({ error: "Could not load AI usage." }, { status: 500 });
  }
}
