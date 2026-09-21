/** Client-safe money helpers (no server imports). */
export function fmtMoney(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format((minor || 0) / 100);
  } catch {
    return `${((minor || 0) / 100).toFixed(2)} ${currency}`;
  }
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

export const STATUS_TONE: Record<string, string> = {
  draft: "bg-secondary text-muted-foreground",
  sent: "bg-blue-500/15 text-blue-600 dark:text-blue-300",
  viewed: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-300",
  accepted: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300",
  paid: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300",
  partially_paid: "bg-amber-500/15 text-amber-600 dark:text-amber-300",
  declined: "bg-red-500/15 text-red-600 dark:text-red-300",
  expired: "bg-red-500/15 text-red-600 dark:text-red-300",
  overdue: "bg-red-500/15 text-red-600 dark:text-red-300",
  void: "bg-secondary text-muted-foreground line-through",
};
