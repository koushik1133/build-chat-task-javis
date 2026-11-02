"use client";

import type { LucideIcon } from "lucide-react";
import { AlertTriangle, CheckCircle2, Info, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/* Shared async-state surfaces: banners, empty states, loading and error states. */

export type BannerTone = "error" | "warn" | "info" | "success";

const BANNER: Record<BannerTone, { cls: string; Icon: LucideIcon }> = {
  error: { cls: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300", Icon: AlertTriangle },
  warn: { cls: "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300", Icon: AlertTriangle },
  success: { cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300", Icon: CheckCircle2 },
  info: { cls: "border-border bg-secondary/40 text-foreground", Icon: Info },
};

export function Banner({
  tone = "info",
  children,
  onDismiss,
  className,
}: {
  tone?: BannerTone;
  children: React.ReactNode;
  onDismiss?: () => void;
  className?: string;
}) {
  const { cls, Icon } = BANNER[tone];
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cn("mb-4 flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm", cls, className)}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">{children}</div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-my-1.5 -mr-1.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md opacity-70 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      )}
    </div>
  );
}

export function Empty({
  icon,
  title,
  text,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  text?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center rounded-xl border border-dashed border-border px-4 py-12 text-center", className)}>
      {icon && (
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-secondary text-muted-foreground" aria-hidden>
          {icon}
        </div>
      )}
      <p className="text-balance text-sm font-medium">{title}</p>
      {text && <p className="mt-1 max-w-sm text-pretty text-sm text-muted-foreground">{text}</p>}
      {action && <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

export function Loading({ label = "Loading…", className }: { label?: string; className?: string }) {
  return (
    <div role="status" aria-live="polite" className={cn("flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground", className)}>
      <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden />
      {label}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-secondary motion-reduce:animate-none", className)} aria-hidden />;
}

/** A stack of placeholder rows that announces itself as busy to assistive tech. */
export function SkeletonList({ count = 3, itemClassName = "h-16", className, label = "Loading…" }: { count?: number; itemClassName?: string; className?: string; label?: string }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className={cn("space-y-2", className)}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className={cn("w-full rounded-lg", itemClassName)} />
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function ErrorState({ message, onRetry, className }: { message: string; onRetry?: () => void; className?: string }) {
  return (
    <div role="alert" className={cn("rounded-xl border border-red-500/30 bg-red-500/5 p-8 text-center", className)}>
      <p className="text-sm font-medium text-red-700 dark:text-red-300">{message}</p>
      {onRetry && (
        <Button size="sm" variant="outline" className="mt-3" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
