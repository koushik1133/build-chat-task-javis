"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export interface TabDef<T extends string> {
  id: T;
  label: string;
  count?: number;
}

/**
 * Segmented tab list with roving focus: ←/→/Home/End move and select.
 * Pair with <TabPanel id={id} value={value}> so the panel is labelled by its tab.
 */
export function Tabs<T extends string>({
  id,
  tabs,
  value,
  onChange,
  label,
  className,
}: {
  id: string;
  tabs: ReadonlyArray<TabDef<T>>;
  value: T;
  onChange: (t: T) => void;
  label: string;
  className?: string;
}) {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the active tab visible when the strip scrolls (phones): scroll the strip itself, never the page.
  useEffect(() => {
    const list = listRef.current;
    const el = refs.current.get(value);
    if (!list || !el || list.scrollWidth <= list.clientWidth) return;
    const left = el.offsetLeft - (list.clientWidth - el.offsetWidth) / 2;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    list.scrollTo({ left: Math.max(0, left), behavior: reduce ? "auto" : "smooth" });
  }, [value]);

  function onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, idx: number) {
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (idx + 1) % tabs.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next === null) return;
    e.preventDefault();
    const key = tabs[next].id;
    onChange(key);
    refs.current.get(key)?.focus();
  }

  return (
    <div ref={listRef} role="tablist" aria-label={label} className={cn("relative flex max-w-full items-center gap-1 overflow-x-auto overscroll-x-contain rounded-lg border border-border bg-card p-1", className)}>
      {tabs.map((t, i) => {
        const active = value === t.id;
        return (
          <button
            key={t.id}
            ref={(el) => {
              if (el) refs.current.set(t.id, el);
              else refs.current.delete(t.id);
            }}
            id={`${id}-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={`${id}-panel-${t.id}`}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "inline-flex min-h-11 shrink-0 touch-manipulation items-center whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none sm:min-h-8",
              active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
            )}
          >
            {t.label}
            {t.count !== undefined && (
              <span className={cn("ml-1.5 rounded-full px-1.5 text-[11px] tabular-nums", active ? "bg-primary-foreground/20" : "bg-secondary")}>{t.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ id, value, children, className }: { id: string; value: string; children: React.ReactNode; className?: string }) {
  return (
    <div
      id={`${id}-panel-${value}`}
      role="tabpanel"
      aria-labelledby={`${id}-tab-${value}`}
      tabIndex={0}
      className={cn("rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}
    >
      {children}
    </div>
  );
}
