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
} from "lucide-react";
import { cn, timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

type Chat = { id: string; title: string; updated_at: string };

export function Sidebar({ userEmail }: { userEmail: string }) {
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

  return (
    <aside className="flex h-full w-52 flex-col border-r border-border bg-card">
      <div className="px-3 py-3">
        <div className="mb-1 flex items-center justify-between text-xs uppercase tracking-wider text-muted-foreground">
          <span>Recent chats</span>
          <Link href="/chat" className="hover:text-foreground">
            <Plus className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>

      <div className="scrollbar-thin flex-1 overflow-y-auto px-2 pb-2">
        {chats.length === 0 ? (
          <p className="px-2 text-xs text-muted-foreground">No chats yet.</p>
        ) : (
          chats.map((c) => {
            const active = pathname === `/chat/${c.id}`;
            return (
              <Link
                key={c.id}
                href={`/chat/${c.id}`}
                className={cn(
                  "block rounded-md px-2 py-1.5 text-xs",
                  active ? "bg-secondary" : "text-muted-foreground hover:bg-secondary/60"
                )}
              >
                <div className="truncate">{c.title}</div>
                <div className="text-[10px] opacity-60">{timeAgo(c.updated_at)}</div>
              </Link>
            );
          })
        )}
      </div>

      <div className="space-y-2 border-t border-border p-3">
        <div className="flex items-center justify-between">
          <button
            onClick={toggleTheme}
            className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {dark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            {dark ? "Light mode" : "Dark mode"}
          </button>
          <span className="flex items-center gap-0.5 rounded border border-border px-1 py-0.5 text-[10px] text-muted-foreground">
            <Command className="h-2.5 w-2.5" />K
          </span>
        </div>
        <div className="truncate text-xs text-muted-foreground">{userEmail}</div>
        <Link href="/settings/integrations">
          <Button variant="ghost" size="sm" className="w-full justify-start">
            <Plug className="h-3.5 w-3.5" /> Connections
          </Button>
        </Link>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full justify-start"
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
