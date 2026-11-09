"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";

/** "All / My tasks" filter for /tasks — a thin link toggle driven by ?mine=1. */
export function TasksViewSwitch({ mine }: { mine: boolean }) {
  const cls = (active: boolean) =>
    cn("inline-flex min-h-9 items-center px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", active ? "bg-secondary" : "hover:bg-secondary/60");
  return (
    <nav aria-label="Task view" className="inline-flex overflow-hidden rounded-md border border-border">
      <Link href="/tasks" aria-current={!mine ? "page" : undefined} className={cls(!mine)}>
        All
      </Link>
      <Link href="/tasks?mine=1" aria-current={mine ? "page" : undefined} className={cn(cls(mine), "border-l border-border")}>
        My tasks
      </Link>
    </nav>
  );
}
