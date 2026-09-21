"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CheckSquare } from "lucide-react";
import { NotificationBell } from "@/components/notification-bell";

const APPROVALS_POLL_MS = 60_000;

/** Small pending-approvals pill that lives next to the bell. */
function ApprovalsBadge() {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/approvals?status=pending&count=1", { cache: "no-store" });
        if (!res.ok) return;
        const d = await res.json();
        if (!cancelled && typeof d.count === "number") setCount(d.count);
      } catch {
        /* ignore */
      }
    }
    load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, APPROVALS_POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  const n = count ?? 0;
  return (
    <Link
      href="/approvals"
      aria-label={n > 0 ? `${n} pending approval${n === 1 ? "" : "s"}` : "Approvals inbox"}
      title="Approvals"
      className="relative flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground shadow-md transition-colors hover:bg-secondary hover:text-foreground"
    >
      <CheckSquare className="h-5 w-5" />
      {n > 0 && (
        <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
          {n > 99 ? "99+" : n}
        </span>
      )}
    </Link>
  );
}

/** Fixed top-right bell on every app page except Production and Build/AI Studio (which have their own inline bells). */
export function GlobalNotificationBell() {
  const pathname = usePathname();
  if (
    pathname === "/production" || pathname.startsWith("/production/") ||
    pathname === "/build" || pathname.startsWith("/build/")
  ) {
    return null;
  }
  return (
    <>
      <div className="fixed right-[4.25rem] top-16 z-50 lg:right-[4.75rem]">
        <ApprovalsBadge />
      </div>
      <NotificationBell variant="fixed" />
    </>
  );
}
