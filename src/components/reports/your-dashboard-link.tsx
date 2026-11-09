"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, LayoutDashboard } from "lucide-react";

/** Home: links to /reports when an admin has saved a default dashboard for the viewer's role. */
export function YourDashboardLink() {
  const [dash, setDash] = useState<{ name: string } | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/dashboards?default=1", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { dashboard?: { name: string }; saved?: boolean } | null) => {
        if (live && d?.saved && d.dashboard) setDash(d.dashboard);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  if (!dash) return null;
  return (
    <div className="mx-auto mb-4 w-full max-w-7xl px-4 sm:px-6 lg:px-8">
      <Link href="/reports" className="flex min-h-11 items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-2.5 text-sm hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="flex min-w-0 items-center gap-2"><LayoutDashboard className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden /><span className="truncate">Your dashboard: <span className="font-medium">{dash.name}</span></span></span>
        <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      </Link>
    </div>
  );
}
