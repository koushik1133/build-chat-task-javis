"use client";

import Link from "next/link";
import { Sparkles } from "lucide-react";
import { FEATURE_LABEL, METRIC_LABEL, type FeatureKey, type Metric } from "@/lib/plans/catalog";
import { cn } from "@/lib/utils";
import { useEntitlement } from "./use-entitlement";

/**
 * Inline "Upgrade" nudge. Renders nothing unless plans are enforced and the
 * workspace is blocked on the given feature or metric.
 */
export function UpgradePrompt({ feature, metric, increment = 1, className }: { feature?: FeatureKey; metric?: Metric; increment?: number; className?: string }) {
  const { state, hasFeature, atLimit } = useEntitlement();
  if (!state || !state.enforced) return null;
  const blocked = feature ? !hasFeature(feature) : metric ? atLimit(metric, increment) : false;
  if (!blocked) return null;
  const what = feature ? FEATURE_LABEL[feature] : metric ? METRIC_LABEL[metric] : "This";
  const hint = feature ? state.upgrade_hints[feature] : null;
  return (
    <div role="status" className={cn("flex flex-wrap items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200", className)}>
      <Sparkles className="h-4 w-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        {feature ? `${what} is not included in your plan.` : `You have reached your plan limit for ${what.toLowerCase()}.`}
      </span>
      <Link href={hint ? `/settings/plan?upgrade=${hint}` : "/settings/plan"} className="inline-flex min-h-11 items-center rounded-md font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0">
        Upgrade plan
      </Link>
    </div>
  );
}
