"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { Check, Minus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { fmtMoney } from "@/lib/money/format";
import {
  FEATURE_KEYS,
  FEATURE_LABEL,
  PLANS,
  annualSavingsPercent,
  listPlans,
  planPriceIn,
  type BillingInterval,
  type LimitKey,
  type PlanDef,
  type PlanKey,
} from "@/lib/plans/catalog";
import { cn } from "@/lib/utils";

const LIMIT_ROWS: Array<{ key: LimitKey; label: string; fmt?: (n: number) => string }> = [
  { key: "seats", label: "Team seats included" },
  { key: "contacts", label: "Contacts" },
  { key: "ai_credits_included_per_month", label: "AI credits / month" },
  { key: "storage_mb", label: "Storage", fmt: (n) => (n >= 1024 ? `${Math.round(n / 1024)} GB` : `${n} MB`) },
  { key: "child_workspaces", label: "Client workspaces" },
  { key: "api_rate_limit_per_min", label: "API requests / minute" },
];

function limitText(plan: PlanDef, key: LimitKey, fmt?: (n: number) => string): string {
  const v = plan.entitlements.limits[key];
  if (v === null) return "Unlimited";
  if (v === 0) return "None";
  return fmt ? fmt(v) : new Intl.NumberFormat().format(v);
}

export interface PlanGridProps {
  currency: string;
  /** Plan the workspace is on now (marks the column and chooses Upgrade/Downgrade labels). */
  current?: PlanKey;
  initialInterval?: BillingInterval;
  busy?: boolean;
  /** In-app: choose handler. On the public page pass `hrefFor` instead. */
  onChoose?: (plan: PlanKey, interval: BillingInterval) => void;
  hrefFor?: (plan: PlanKey, interval: BillingInterval) => string;
}

export function PlanGrid({ currency, current, initialInterval = "month", busy, onChoose, hrefFor }: PlanGridProps) {
  const [interval, setInterval] = useState<BillingInterval>(initialInterval);
  const groupId = useId();
  const plans = listPlans();
  const best = Math.max(...plans.map(annualSavingsPercent));

  return (
    <section aria-labelledby={`${groupId}-h`}>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 id={`${groupId}-h`} className="text-lg font-semibold">Compare plans</h2>
        <div role="group" aria-label="Billing interval" className="inline-flex rounded-md border border-border p-0.5">
          {(["month", "year"] as const).map((i) => (
            <button
              key={i}
              type="button"
              aria-pressed={interval === i}
              onClick={() => setInterval(i)}
              className={cn("min-h-11 rounded px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8", interval === i ? "bg-primary text-primary-foreground" : "hover:bg-secondary/60")}
            >
              {i === "month" ? "Monthly" : `Annual${best > 0 ? ` (save ${best}%)` : ""}`}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {plans.map((p) => {
          const { currency: cur, price } = planPriceIn(p, currency);
          const amount = interval === "year" ? price.year : price.month;
          const isCurrent = current === p.key;
          const label = isCurrent ? "Current plan" : !p.selfServe ? "Contact us" : current && PLANS[current].rank > p.rank ? "Downgrade" : "Choose " + p.name;
          return (
            <article key={p.key} aria-label={`${p.name} plan`} className={cn("flex flex-col rounded-lg border p-4", isCurrent ? "border-primary ring-1 ring-primary" : "border-border")}>
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-base font-semibold">{p.name}</h3>
                {isCurrent && <Pill tone="info">Current</Pill>}
              </div>
              <p className="mt-1 min-h-10 text-xs text-muted-foreground">{p.tagline}</p>
              <p className="mt-3 text-2xl font-semibold tabular-nums">
                {!p.selfServe ? "Custom" : amount === 0 ? "Free" : fmtMoney(amount, cur)}
                {p.selfServe && amount > 0 && <span className="text-sm font-normal text-muted-foreground"> / {interval === "year" ? "year" : "month"}</span>}
              </p>
              {interval === "year" && p.selfServe && amount > 0 && annualSavingsPercent(p) > 0 && (
                <p className="text-xs text-emerald-700 dark:text-emerald-300">Save {annualSavingsPercent(p)}% vs monthly</p>
              )}
              <ul className="mt-3 space-y-1 text-sm">
                {LIMIT_ROWS.map((r) => (
                  <li key={r.key} className="flex justify-between gap-2">
                    <span className="text-muted-foreground">{r.label}</span>
                    <span className="tabular-nums">{limitText(p, r.key, r.fmt)}</span>
                  </li>
                ))}
              </ul>
              <ul className="mt-3 flex-1 space-y-1 text-sm">
                {FEATURE_KEYS.map((f) => {
                  const on = p.entitlements.features[f];
                  return (
                    <li key={f} className={cn("flex items-start gap-2", !on && "text-muted-foreground")}>
                      {on ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden /> : <Minus className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
                      <span>{FEATURE_LABEL[f]}<span className="sr-only">{on ? " included" : " not included"}</span></span>
                    </li>
                  );
                })}
              </ul>
              <div className="mt-4">
                {hrefFor && p.selfServe ? (
                  <Link href={hrefFor(p.key, interval)} className="inline-flex min-h-11 w-full items-center justify-center rounded-md border border-border px-4 text-sm font-medium hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {p.key === "free" ? "Start free" : `Start with ${p.name}`}
                  </Link>
                ) : (
                  <Button
                    touch
                    className="w-full"
                    variant={isCurrent || !p.selfServe ? "outline" : "default"}
                    disabled={isCurrent || busy || (!p.selfServe && !onChoose)}
                    onClick={() => (p.selfServe ? onChoose?.(p.key, interval) : window.location.assign("mailto:sales@kernelhub.app?subject=KernelHub%20Enterprise"))}
                  >
                    {label}
                  </Button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
