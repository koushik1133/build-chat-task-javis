"use client";

import { useState } from "react";
import { Copy, Gift, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProgressBar, EmptyNote, Section, dateOnly } from "./portal-ui";
import type { PortalLoyalty } from "@/lib/engagement/portal";

/** Portal "Rewards" tab: points balance, tier progress, history and the referral card. */
export function RewardsTab({ loyalty, token }: { loyalty: PortalLoyalty; token?: string }) {
  const [copied, setCopied] = useState(false);
  const next = loyalty.next_tier;
  const pct = next ? Math.min(100, Math.round((loyalty.lifetime_points / (loyalty.lifetime_points + next.points_to_go)) * 100)) : 100;
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  }
  return (
    <div className="space-y-4">
      <Section icon={Gift} title="Your rewards" id="rw-balance">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-3xl font-semibold tabular-nums">{loyalty.balance.toLocaleString()} <span className="text-base font-normal text-muted-foreground">points</span></div>
            <div className="text-sm text-muted-foreground">{loyalty.tier ? `${loyalty.tier} member` : "Member"}{loyalty.tier_perks ? ` · ${loyalty.tier_perks}` : ""}</div>
          </div>
          {loyalty.shop_slug && token && loyalty.balance >= loyalty.min_redeem_points && (
            <Button asChild size="sm" touch><a href={`/shop/${encodeURIComponent(loyalty.shop_slug)}/checkout?pt=${encodeURIComponent(token)}`}>Spend points in the shop</a></Button>
          )}
        </div>
        {next ? (
          <div className="mt-4 space-y-1">
            <ProgressBar percent={pct} label={`Progress to ${next.name}`} />
            <p className="text-xs text-muted-foreground">{next.points_to_go.toLocaleString()} more points to reach {next.name}.</p>
          </div>
        ) : null}
      </Section>

      {loyalty.referral && (
        <Section icon={Share2} title="Refer a friend" id="rw-refer">
          <p className="text-sm text-muted-foreground">Share your link. When a friend makes their first purchase, you earn bonus points.</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code className="rounded bg-secondary px-2 py-1 text-sm">{loyalty.referral.code}</code>
            {loyalty.referral.url && (
              <Button variant="outline" size="sm" touch onClick={() => void copy(loyalty.referral?.url ?? "")}>
                <Copy className="mr-1 h-4 w-4" aria-hidden /> {copied ? "Copied" : "Copy link"}
              </Button>
            )}
          </div>
        </Section>
      )}

      <Section icon={Gift} title="Points history" id="rw-history">
        {loyalty.history.length === 0 ? (
          <EmptyNote text="No points activity yet." />
        ) : (
          <ul className="divide-y divide-border/60">
            {loyalty.history.map((h) => (
              <li key={h.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div>
                  <div className="font-medium capitalize">{h.kind}{h.note ? ` · ${h.note}` : ""}</div>
                  <div className="text-xs text-muted-foreground">{dateOnly(h.created_at)}</div>
                </div>
                <div className={h.points >= 0 ? "tabular-nums text-emerald-600 dark:text-emerald-400" : "tabular-nums text-muted-foreground"}>{h.points > 0 ? "+" : ""}{h.points.toLocaleString()}</div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
