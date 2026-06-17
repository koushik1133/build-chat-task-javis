"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  MessageSquare, Wand2, FileText, Github, ListTodo,
  BarChart2, Briefcase, Bot, Zap, Kanban,
  ArrowRight, Search, X,
} from "lucide-react";
import { cn } from "@/lib/utils";

const COMMANDS = [
  { label: "New Chat", category: "ACTIONS", href: "/chat", icon: MessageSquare },
  { label: "Launch AI Agent", category: "ACTIONS", href: "/agents", icon: Bot },
  { label: "New Strategy Proposal", category: "ACTIONS", href: "/strategy", icon: Briefcase },
  { label: "Create Workflow", category: "ACTIONS", href: "/automations", icon: Zap },
  { label: "View Analytics", category: "NAVIGATION", href: "/analytics", icon: BarChart2 },
  { label: "Check Automations", category: "NAVIGATION", href: "/automations", icon: Zap },
  { label: "Production Board", category: "NAVIGATION", href: "/production", icon: Kanban },
  { label: "Strategy Hub", category: "NAVIGATION", href: "/strategy", icon: Briefcase },
  { label: "AI Studio / Build", category: "NAVIGATION", href: "/build", icon: Wand2 },
  { label: "Files & RAG", category: "NAVIGATION", href: "/files", icon: FileText },
  { label: "GitHub Review", category: "NAVIGATION", href: "/github", icon: Github },
  { label: "Tasks", category: "NAVIGATION", href: "/tasks", icon: ListTodo },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const router = useRouter();

  const filtered = COMMANDS.filter((c) =>
    c.label.toLowerCase().includes(query.toLowerCase()) ||
    c.category.toLowerCase().includes(query.toLowerCase())
  );

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setSelected(0);
  }, []);

  const go = useCallback(
    (href: string) => {
      router.push(href);
      close();
    },
    [router, close]
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (!open) return;
      if (e.key === "Escape") close();
      if (e.key === "ArrowDown") setSelected((s) => Math.min(s + 1, filtered.length - 1));
      if (e.key === "ArrowUp") setSelected((s) => Math.max(s - 1, 0));
      if (e.key === "Enter" && filtered[selected]) go(filtered[selected].href);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, filtered, selected, close, go]);

  if (!open) return null;

  const groups = Array.from(new Set(filtered.map((c) => c.category)));

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      onClick={close}
    >
      {/* backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />

      <div
        className="relative z-10 w-full max-w-lg rounded-xl border border-border bg-card shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search bar */}
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelected(0); }}
            placeholder="Type a command or search..."
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <button onClick={close}>
            <X className="h-4 w-4 text-muted-foreground hover:text-foreground" />
          </button>
        </div>

        {/* Results */}
        <div className="max-h-80 overflow-y-auto py-2">
          {filtered.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">No results.</p>
          )}
          {groups.map((group) => (
            <div key={group}>
              <div className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {group}
              </div>
              {filtered
                .filter((c) => c.category === group)
                .map((cmd, i) => {
                  const globalIdx = filtered.indexOf(cmd);
                  const Icon = cmd.icon;
                  return (
                    <button
                      key={cmd.label + i}
                      onClick={() => go(cmd.href)}
                      onMouseEnter={() => setSelected(globalIdx)}
                      className={cn(
                        "flex w-full items-center gap-3 px-4 py-2.5 text-sm transition-colors",
                        selected === globalIdx
                          ? "bg-secondary text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0 text-primary" />
                      <span className="flex-1 text-left">{cmd.label}</span>
                      <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                        GO <ArrowRight className="h-3 w-3" />
                      </span>
                    </button>
                  );
                })}
            </div>
          ))}
        </div>

        <div className="border-t border-border px-4 py-2 flex items-center gap-4 text-[10px] text-muted-foreground">
          <span><kbd className="font-mono">↑↓</kbd> navigate</span>
          <span><kbd className="font-mono">↵</kbd> open</span>
          <span><kbd className="font-mono">esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
