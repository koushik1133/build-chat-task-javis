"use client";

import { useState } from "react";
import { ChevronDown, MapPin } from "lucide-react";
import { api } from "@/components/finance/shared";
import { Skeleton } from "@/components/ui/feedback";
import type { LevelItem } from "./types";

/** Disclosure showing one product's stock per location (fetched on first open). */
export function StockBreakdown({ productId, productName }: { productId: string; productName: string }) {
  const [open, setOpen] = useState(false);
  const [levels, setLevels] = useState<LevelItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && levels === null) {
      try {
        const r = await api<{ levels: LevelItem[] }>(`/api/stock/levels?product=${encodeURIComponent(productId)}`);
        setLevels(r.levels);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load locations.");
      }
    }
  }

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => void toggle()}
        aria-expanded={open}
        aria-label={`Stock by location for ${productName}`}
        className="inline-flex items-center gap-1 rounded text-xs text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <MapPin className="h-3 w-3" aria-hidden /> By location <ChevronDown className={open ? "h-3 w-3 rotate-180" : "h-3 w-3"} aria-hidden />
      </button>
      {open && (
        <div className="mt-1 rounded-md border border-border bg-card p-2 text-xs shadow-sm">
          {error ? (
            <p className="text-red-700 dark:text-red-300">{error}</p>
          ) : levels === null ? (
            <Skeleton className="h-8 w-40" />
          ) : levels.length === 0 ? (
            <p className="text-muted-foreground">No location stock yet.</p>
          ) : (
            <ul className="space-y-0.5">
              {levels.map((l) => (
                <li key={l.location_id} className="flex justify-between gap-4 tabular-nums">
                  <span className="truncate">{l.location_name}</span>
                  <span>
                    {l.available} <span className="text-muted-foreground">/ {l.on_hand}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
