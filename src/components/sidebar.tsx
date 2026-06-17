"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  MessageSquare,
  FileText,
  Github,
  ListTodo,
  LogOut,
  Plus,
  Sparkles,
  Wand2,
  BarChart2,
  Briefcase,
  Bot,
  Zap,
  Kanban,
  Moon,
  Sun,
  Command,
  Plug,
} from "lucide-react";
import { cn, timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

type Chat = { id: string; title: string; updated_at: string };

const NAV_TOP = [
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/files", label: "Files", icon: FileText },
  { href: "/github", label: "GitHub", icon: Github },
  { href: "/build", label: "AI Studio", icon: Wand2 },
];

const NAV_BOTTOM = [
  { href: "/production", label: "Production", icon: Kanban },
  { href: "/agents", label: "AI Agents", icon: Bot },
  { href: "/automations", label: "Automations", icon: Zap },
  { href: "/strategy", label: "Strategy Hub", icon: Briefcase },
  { href: "/analytics", label: "Data Analysis", icon: BarChart2 },
  { href: "/tasks", label: "Tasks", icon: ListTodo },
];

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
    <aside className="flex h-full w-56 flex-col border-r border-border bg-card">
      {/* Brand */}
      <div className="flex items-center gap-2 px-4 py-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/15">
          <Sparkles className="h-4 w-4 text-primary" />
        </div>
        <span className="text-sm font-semibold tracking-tight">Javis</span>
      </div>

      {/* Main nav */}
      <nav className="px-2 space-y-0.5">
        {NAV_TOP.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-2 rounded-md px-2.5 py-2 text-sm transition-colors",
                active
                  ? "bg-secondary text-foreground font-medium"
                  : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </Link>
          );
        })}
      </nav>

      {/* Divider + secondary nav */}
      <div className="mx-3 my-2 border-t border-border" />
      <nav className="px-2 space-y-0.5">
        {NAV_BOTTOM.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-2 rounded-md px-2.5 py-2 text-sm transition-colors",
                active
                  ? "bg-secondary text-foreground font-medium"
                  : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </Link>
          );
        })}
      </nav>

      {/* Recent chats */}
      <div className="mt-3 px-3">
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

      {/* Footer: theme toggle + Cmd+K hint + signout */}
      <div className="border-t border-border p-3 space-y-2">
        <div className="flex items-center justify-between">
          <button
            onClick={toggleTheme}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {dark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            {dark ? "Light mode" : "Dark mode"}
          </button>
          <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground border border-border rounded px-1 py-0.5">
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
