"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Bounded horizontal scroll region for wide tables: the page never scrolls
 * sideways, keyboard users can scroll it, and a hint appears when columns are cut off.
 */
export function TableScroller({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setOverflowing(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, []);

  return (
    <div className={cn("min-w-0", className)}>
      <div
        ref={ref}
        role="region"
        aria-label={label}
        tabIndex={overflowing ? 0 : undefined}
        className="scrollbar-thin overflow-x-auto overscroll-x-contain rounded-lg border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {children}
      </div>
      {overflowing && <p className="mt-1.5 text-xs text-muted-foreground">Scroll sideways to see all columns.</p>}
    </div>
  );
}

export const TH = "px-3 py-2 text-left font-medium";
export const THEAD = "bg-secondary/40 text-xs uppercase tracking-wide text-muted-foreground";
