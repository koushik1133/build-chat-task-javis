"use client";

import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";
import { Sidebar } from "@/components/sidebar";
import { GlobalNotificationBell } from "@/components/global-notification-bell";
import { KERNELHUB_NAME } from "@/lib/brand";
import { cn } from "@/lib/utils";

export function AppShell({
  userEmail,
  children,
}: {
  userEmail: string;
  children: React.ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const onChange = () => {
      if (mq.matches) setMobileOpen(false);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (mobileOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileOpen]);

  return (
    <div className="flex h-[100dvh] w-screen overflow-hidden">
      {mobileOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px] lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <Sidebar
        userEmail={userEmail}
        mobileOpen={mobileOpen}
        onNavigate={() => setMobileOpen(false)}
        onClose={() => setMobileOpen(false)}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card px-3 sm:px-4 lg:hidden">
          <button
            type="button"
            aria-label="Open navigation"
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen(v => !v)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            {mobileOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
          <span className="truncate text-sm font-semibold tracking-tight">{KERNELHUB_NAME}</span>
        </header>

        <main className={cn("min-h-0 min-w-0 flex-1 overflow-hidden bg-background")}>
          {children}
        </main>
        <GlobalNotificationBell />
      </div>
    </div>
  );
}
