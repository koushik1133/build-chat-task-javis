"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  MessageSquare,
  FileText,
  Github,
  ListTodo,
  LogOut,
  Plus,
  Sparkles,
} from "lucide-react";
import { cn, timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type Chat = { id: string; title: string; updated_at: string };

const NAV = [
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/files", label: "Files", icon: FileText },
  { href: "/github", label: "GitHub", icon: Github },
  { href: "/tasks", label: "Tasks", icon: ListTodo },
];

export function Sidebar({ userEmail }: { userEmail: string }) {
  const pathname = usePathname();
  const [chats, setChats] = useState<Chat[]>([]);

  useEffect(() => {
    fetch("/api/chats")
      .then((r) => r.json())
      .then((d) => setChats(d.chats ?? []))
      .catch(() => {});
  }, [pathname]);

  return (
    <aside className="flex h-full w-64 flex-col border-r border-border bg-card">
      <div className="flex items-center gap-2 px-4 py-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/15">
          <Sparkles className="h-4 w-4 text-primary" />
        </div>
        <span className="text-sm font-semibold tracking-tight">Javis</span>
      </div>

      <nav className="px-2">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-2 rounded-md px-2.5 py-2 text-sm transition-colors",
                active
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-4 px-3">
        <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-wider text-muted-foreground">
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

      <form action="/api/auth/signout" method="post" className="border-t border-border p-3">
        <div className="mb-2 truncate text-xs text-muted-foreground">{userEmail}</div>
        <Button type="submit" variant="ghost" size="sm" className="w-full justify-start">
          <LogOut className="h-3.5 w-3.5" /> Sign out
        </Button>
      </form>
    </aside>
  );
}
