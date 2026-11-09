"use client";

import type { LucideIcon } from "lucide-react";

export const money = (minor: number, currency: string) => new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minor / 100);
export const whenIn = (iso: string, tz: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: tz }).format(new Date(iso));
export const dateOnly = (iso: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(iso));

/** Titled card used by every portal tab. */
export function Section({ icon: Icon, title, id, children, aside }: { icon: LucideIcon; title: string; id: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 id={id} className="flex items-center gap-2 text-sm font-semibold">
          <Icon className="h-4 w-4 text-primary" aria-hidden /> {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export const EmptyNote = ({ text }: { text: string }) => <p className="text-sm text-muted-foreground">{text}</p>;

export function ProgressBar({ percent, label }: { percent: number; label: string }) {
  return (
    <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={label} className="h-2 w-full overflow-hidden rounded-full bg-secondary">
      <div className="h-full rounded-full bg-primary transition-[width] motion-reduce:transition-none" style={{ width: `${percent}%` }} />
    </div>
  );
}
