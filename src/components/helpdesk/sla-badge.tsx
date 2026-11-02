"use client";

import { AlertTriangle, CheckCircle2, Clock } from "lucide-react";
import { TONE, type Tone } from "@/components/ui/pill";
import { cn } from "@/lib/utils";
import { formatCountdown, slaHealth, type SlaHealth } from "@/lib/helpdesk/sla";

export { Pill, StatusPill } from "@/components/ui/pill";

const HEALTH_TONE: Record<SlaHealth, Tone> = {
  none: "neutral",
  ok: "success",
  warning: "warning",
  breached: "danger",
  met: "neutral",
};

/**
 * SLA countdown pill. `label` names the clock ("Reply" or "Resolve").
 * Breached state wins even when the clock reads the same, so the sweep's
 * flag and the live countdown never disagree visually. Icon + text carry the
 * state, so colour is never the only signal.
 */
export function SlaBadge({
  label,
  dueAt,
  satisfiedAt,
  breached,
  now,
  className,
}: {
  label: string;
  dueAt: string | null;
  satisfiedAt: string | null;
  breached?: boolean;
  now: Date;
  className?: string;
}) {
  if (!dueAt) return null;
  const health: SlaHealth = breached && !satisfiedAt ? "breached" : slaHealth(dueAt, satisfiedAt, now);
  const Icon = health === "breached" ? AlertTriangle : health === "met" ? CheckCircle2 : Clock;
  const text =
    health === "met" ? "met" : health === "breached" ? `breached ${formatCountdown(dueAt, now).replace("-", "")} ago` : `due in ${formatCountdown(dueAt, now)}`;
  const title =
    health === "met"
      ? `${label} target met`
      : `${label} target ${health === "breached" ? "breached" : "due"} ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(dueAt))}`;
  return (
    <span
      title={title}
      className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums", TONE[HEALTH_TONE[health]], className)}
    >
      <Icon className="h-3 w-3" aria-hidden />
      <span className="sr-only">{label} target: </span>
      <span aria-hidden>{label} </span>
      {text}
    </span>
  );
}

export const PRIORITY_TONE: Record<string, Tone> = {
  low: "neutral",
  normal: "info",
  high: "warning",
  urgent: "danger",
};

export const TICKET_STATUS_TONE: Record<string, Tone> = {
  open: "success",
  pending: "warning",
  resolved: "neutral",
  closed: "neutral",
};
