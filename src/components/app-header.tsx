"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { APP_NAV } from "@/lib/app-nav";
import { NotificationBell } from "@/components/notification-bell";

export function AppHeader() {
  const pathname = usePathname();

  return (
    <header className="flex h-12 shrink-0 items-center gap-4 border-b border-border bg-card px-4">
      <Link href="/chat" className="flex shrink-0 items-center gap-2 pr-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/15">
          <Sparkles className="h-4 w-4 text-primary" />
        </div>
        <span className="hidden text-sm font-semibold tracking-tight sm:inline">
          Kernel<span className="text-primary">Hub</span>
        </span>
      </Link>

      <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto scrollbar-thin">
        {APP_NAV.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors sm:text-sm",
                active
                  ? "bg-secondary font-medium text-foreground"
                  : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
              )}
            >
              <Icon className="h-3.5 w-3.5 shrink-0 sm:h-4 sm:w-4" />
              <span className="hidden md:inline">{label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="flex shrink-0 items-center pl-2">
        <NotificationBell />
      </div>
    </header>
  );
}
