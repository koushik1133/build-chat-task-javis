"use client";

import { useCallback, useEffect, useState } from "react";
import { Banner, Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { Pill } from "@/components/ui/pill";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import type { ReferralDTO } from "@/lib/engagement/referrals";
import { apiJson, errMsg } from "./shared";

const TONE = { pending: "warning", qualified: "info", rewarded: "success", void: "neutral" } as const;

export function ReferralsTab() {
  const [rows, setRows] = useState<ReferralDTO[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => { try { setRows((await apiJson<{ referrals: ReferralDTO[] }>("/api/engagement/referrals")).referrals); setErr(null); } catch (e) { setErr(errMsg(e)); } }, []);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="space-y-4">
      <Banner tone="info">Every rewards member gets a personal link in the customer portal. The referrer earns points when the friend completes a first paid order or invoice. Self-referrals and repeat rewards are blocked automatically.</Banner>
      {err ? <ErrorState message={err} onRetry={() => void load()} /> : !rows ? <Loading label="Loading referrals…" /> : rows.length === 0 ? <Empty title="No referrals yet" text="Referrals appear when someone checks out through a friend's link." /> : (
        <TableScroller label="Referrals">
          <table className="w-full text-sm"><thead className={THEAD}><tr><th className={TH}>Referrer</th><th className={TH}>Friend</th><th className={TH}>Status</th><th className={TH}>Reward</th><th className={TH}>Date</th></tr></thead>
            <tbody className="divide-y divide-border">{rows.map((r) => (
              <tr key={r.id}><td className="px-3 py-2">{r.referrer_name ?? "Contact"}</td><td className="px-3 py-2">{r.referee_name ?? "-"}</td><td className="px-3 py-2"><Pill tone={TONE[r.status as keyof typeof TONE] ?? "neutral"}>{r.status}</Pill></td><td className="px-3 py-2 tabular-nums">{r.reward_points} pts</td><td className="px-3 py-2">{new Date(r.created_at).toLocaleDateString()}</td></tr>
            ))}</tbody></table>
        </TableScroller>
      )}
    </div>
  );
}
