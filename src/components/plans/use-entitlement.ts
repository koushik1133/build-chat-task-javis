"use client";

import { useCallback, useEffect, useState } from "react";
import type { FeatureKey, LimitKey, Metric, PlanKey } from "@/lib/plans/catalog";
import { METRIC_LIMIT } from "@/lib/plans/catalog";

export interface EntitlementState {
  plan: PlanKey;
  status: string;
  limits: Record<LimitKey, number | null>;
  features: Record<FeatureKey, boolean>;
  trial: { active: boolean; endsAt: string | null; daysLeft: number };
  usage: Array<{ metric: Metric; used: number; limit: number | null }>;
  enforced: boolean;
  upgrade_hints: Partial<Record<FeatureKey, PlanKey | null>>;
}

const TTL_MS = 30_000;
let cache: { at: number; data: EntitlementState } | null = null;
let inflight: Promise<EntitlementState | null> | null = null;

async function fetchState(force: boolean): Promise<EntitlementState | null> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.data;
  if (inflight) return inflight;
  inflight = fetch("/api/plans/usage", { cache: "no-store" })
    .then(async (res) => {
      if (!res.ok) return null;
      const data = (await res.json()) as EntitlementState;
      cache = { at: Date.now(), data };
      return data;
    })
    .catch(() => null)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Plan entitlements for the current workspace (cached 30s). Everything is
 * "allowed" until loaded and whenever enforcement is off, so UI never blocks
 * on a slow or failed lookup.
 */
export function useEntitlement() {
  const [state, setState] = useState<EntitlementState | null>(cache?.data ?? null);
  const [loading, setLoading] = useState(!cache);

  const refresh = useCallback(async () => {
    const data = await fetchState(true);
    setState(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    let live = true;
    void fetchState(false).then((d) => {
      if (!live) return;
      setState(d);
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, []);

  const hasFeature = useCallback((f: FeatureKey) => !state || !state.enforced || state.features[f], [state]);
  const atLimit = useCallback(
    (m: Metric, increment = 1) => {
      if (!state || !state.enforced) return false;
      const u = state.usage.find((x) => x.metric === m);
      const limit = u?.limit ?? state.limits[METRIC_LIMIT[m]];
      return limit !== null && limit !== undefined && (u?.used ?? 0) + increment > limit;
    },
    [state]
  );
  return { state, loading, enforced: state?.enforced ?? false, hasFeature, atLimit, refresh };
}
