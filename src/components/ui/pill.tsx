"use client";

import { STATUS_TONE } from "@/lib/money/format";
import { cn } from "@/lib/utils";

/**
 * Status pills. Billing statuses keep their colours from STATUS_TONE; everything
 * else maps onto a small set of tones so the same meaning always looks the same.
 */
export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "accent" | "violet";

export const TONE: Record<Tone, string> = {
  neutral: "bg-secondary text-muted-foreground",
  info: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  success: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  warning: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  danger: "bg-red-500/15 text-red-700 dark:text-red-300",
  accent: "bg-accent text-accent-foreground",
  violet: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
};

export function Pill({
  tone = "neutral",
  children,
  className,
  title,
}: {
  tone?: Tone;
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span title={title} className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium", TONE[tone], className)}>
      {children}
    </span>
  );
}

/** Pill for a status string: billing statuses use STATUS_TONE, others use `map`. */
export function StatusPill({
  status,
  map,
  label,
  className,
}: {
  status: string;
  map?: Record<string, Tone>;
  label?: string;
  className?: string;
}) {
  const cls = STATUS_TONE[status] ?? TONE[map?.[status] ?? "neutral"];
  return (
    <span className={cn("inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium capitalize", cls, className)}>
      {label ?? status.replace(/_/g, " ")}
    </span>
  );
}
