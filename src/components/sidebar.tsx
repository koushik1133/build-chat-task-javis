"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  LogOut,
  Plus,
  Moon,
  Sun,
  Command,
  Plug,
  Sparkles,
  X,
} from "lucide-react";
import { cn, timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { APP_NAV_TOP, APP_NAV_BOTTOM, type AppNavItem } from "@/lib/app-nav";
import { KERNELHUB_NAME, KERNELHUB_TAGLINE } from "@/lib/brand";

type Chat = { id: string; title: string; updated_at: string };

type SidebarProps = {
  userEmail: string;
  mobileOpen?: boolean;
  onNavigate?: () => void;
  onClose?: () => void;
};

export function Sidebar({
  userEmail,
  mobileOpen = false,
  onNavigate,
  onClose,
}: SidebarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [chats, setChats] = useState<Chat[]>([]);
  const [dark, setDark] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const isDark = stored === "dark" || (!stored && prefersDark);
    setDark(isDark);
    document.documentElement.classList.toggle("dark", isDark);
  }, []);

  function toggleTheme() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
  }

  useEffect(() => {
    fetch("/api/chats")
      .then((r) => r.json())
      .then((d) => setChats(d.chats ?? []))
      .catch(() => {});
  }, [pathname]);

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);

    const supabase = createClient();
    await supabase.auth.signOut().catch(() => {});
    await fetch("/api/auth/signout", { method: "POST" }).catch(() => {});

    router.replace("/login?signed_out=1");
    router.refresh();
  }

  function NavLinks({ items }: { items: AppNavItem[] }) {
    return (
      <nav className="space-y-0.5 px-2">
        {items.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              onClick={onNavigate}
              title={label}
              className={cn(
                "nav-item group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-150",
                active
                  ? "nav-item-active bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-secondary/70 hover:text-foreground"
              )}
            >
              <span
                className={cn(
                  "absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-primary transition-opacity duration-150",
                  active ? "opacity-100" : "opacity-0 group-hover:opacity-40"
                )}
                aria-hidden
              />
              <Icon
                className={cn(
                  "h-[18px] w-[18px] shrink-0 transition-all duration-150",
                  active
                    ? "text-primary"
                    : "text-muted-foreground group-hover:scale-105 group-hover:text-foreground"
                )}
              />
              <span className="truncate">{label}</span>
            </Link>
          );
        })}
      </nav>
    );
  }

  return (
    <aside
      className={cn(
        "fixed inset-y-0 left-0 z-50 flex h-[100dvh] w-[min(17.5rem,88vw)] flex-col border-r border-border bg-card shadow-xl transition-transform duration-200 ease-out lg:static lg:z-auto lg:w-60 lg:translate-x-0 lg:shadow-none",
        mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
      )}
    >
      <div className="border-b border-border px-4 py-4">
        <div className="flex items-start justify-between gap-2">
          <Link href="/chat" onClick={onNavigate} className="flex min-w-0 flex-1 items-start gap-2.5">
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 ring-1 ring-primary/25 transition-transform duration-150 hover:scale-105">
              <Sparkles className="h-4 w-4 text-primary" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold leading-tight tracking-tight">{KERNELHUB_NAME}</p>
              <p className="mt-1 line-clamp-2 text-[10px] leading-snug text-muted-foreground">
                {KERNELHUB_TAGLINE}
              </p>
            </div>
          </Link>
          <button
            type="button"
            aria-label="Close sidebar"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground lg:hidden"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="scrollbar-thin flex-1 overflow-y-auto overflow-x-hidden py-2">
        <NavLinks items={APP_NAV_TOP} />

        <div className="mx-3 my-2.5 border-t border-border" />
        <NavLinks items={APP_NAV_BOTTOM} />

        <div className="mt-4 px-3">
          <div className="mb-1.5 flex items-center justify-between text-[11px] uppercase tracking-wider text-muted-foreground">
            <span>Recent chats</span>
            <Link
              href="/chat"
              onClick={onNavigate}
              className="inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-secondary hover:text-foreground"
              aria-label="New chat"
            >
              <Plus className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>

        <div className="px-2 pb-2">
          {chats.length === 0 ? (
            <p className="px-2 text-xs text-muted-foreground">No chats yet.</p>
          ) : (
            chats.map((c) => {
              const active = pathname === `/chat/${c.id}`;
              return (
                <Link
                  key={c.id}
                  href={`/chat/${c.id}`}
                  onClick={onNavigate}
                  className={cn(
                    "group block rounded-lg px-2.5 py-2 text-xs transition-colors duration-150",
                    active
                      ? "bg-secondary text-foreground"
                      : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                  )}
                >
                  <div className="truncate font-medium">{c.title}</div>
                  <div className="mt-0.5 text-[10px] opacity-60">{timeAgo(c.updated_at)}</div>
                </Link>
              );
            })
          )}
        </div>
      </div>

      <div className="space-y-2 border-t border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={toggleTheme}
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            {dark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            <span className="hidden sm:inline">{dark ? "Light mode" : "Dark mode"}</span>
          </button>
          <span className="flex items-center gap-0.5 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
            <Command className="h-2.5 w-2.5" />K
          </span>
        </div>
        <div className="truncate text-xs text-muted-foreground" title={userEmail}>
          {userEmail}
        </div>
        <Link href="/settings/integrations" onClick={onNavigate}>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start transition-colors hover:bg-secondary/70"
          >
            <Plug className="h-3.5 w-3.5" /> Connections
          </Button>
        </Link>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full justify-start transition-colors hover:bg-secondary/70"
          disabled={signingOut}
          onClick={handleSignOut}
        >
          <LogOut className="h-3.5 w-3.5" />
          {signingOut ? "Signing out..." : "Sign out"}
        </Button>
      </div>
    </aside>
  );
}
