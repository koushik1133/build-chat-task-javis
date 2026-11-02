"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import {
  ArrowRight,
  BookOpen,
  Boxes,
  CalendarDays,
  FileText,
  LayoutGrid,
  LifeBuoy,
  ListTodo,
  Loader2,
  Receipt,
  Search,
  Settings,
  Sparkles,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/components/i18n/provider";
import { OPEN_PALETTE_EVENT } from "@/components/search-button";
import { SEARCH_PAGES } from "@/lib/search/pages";
import type { MessageKey } from "@/lib/i18n";

type Kind = "action" | "page" | "contact" | "lead" | "task" | "quote" | "invoice" | "booking" | "ticket" | "record" | "article";

interface Item {
  kind: Kind;
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
}

interface Group {
  kind: Kind;
  label: string;
  items: Item[];
}

const OPEN_COPILOT = "__open-copilot__";
const MIN_CHARS = 2;
const DEBOUNCE_MS = 180;

const ACTIONS: Array<{ key: MessageKey; href: string; icon: LucideIcon; id: string }> = [
  { id: "copilot", key: "search.action.askCopilot", href: OPEN_COPILOT, icon: Sparkles },
  { id: "new-contact", key: "search.action.newContact", href: "/crm?new=1", icon: UserPlus },
  { id: "new-task", key: "search.action.newTask", href: "/tasks?new=1", icon: ListTodo },
  { id: "new-quote", key: "search.action.newQuote", href: "/billing?new=quote", icon: Receipt },
  { id: "settings", key: "search.action.openSettings", href: "/settings/branding", icon: Settings },
];

const ICONS: Record<Kind, LucideIcon> = {
  action: Sparkles,
  page: LayoutGrid,
  contact: Users,
  lead: UserPlus,
  task: ListTodo,
  quote: FileText,
  invoice: Receipt,
  booking: CalendarDays,
  ticket: LifeBuoy,
  record: Boxes,
  article: BookOpen,
};

export function CommandPalette() {
  const t = useT();
  const router = useRouter();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [remote, setRemote] = useState<Group[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setDebounced("");
    setRemote([]);
    setError(null);
    setSelected(0);
    const el = restoreFocus.current;
    restoreFocus.current = null;
    if (el && typeof el.focus === "function") el.focus();
  }, []);

  const openPalette = useCallback(() => {
    restoreFocus.current = document.activeElement as HTMLElement | null;
    setOpen(true);
  }, []);

  // ⌘K / Ctrl+K toggles; external trigger event opens.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (open) close();
        else openPalette();
      }
    }
    function onOpenEvent() {
      if (!open) openPalette();
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_PALETTE_EVENT, onOpenEvent);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpenEvent);
    };
  }, [open, close, openPalette]);

  // Debounce the query.
  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query]);

  // Fetch remote results; abort stale requests.
  useEffect(() => {
    if (!open || debounced.length < MIN_CHARS) {
      setRemote([]);
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/search?q=${encodeURIComponent(debounced)}`, { signal: ctrl.signal, cache: "no-store" })
      .then(async (r) => {
        const data = (await r.json().catch(() => null)) as { groups?: Group[]; error?: string } | null;
        if (!r.ok) throw new Error(data?.error ?? `HTTP ${r.status}`);
        setRemote(Array.isArray(data?.groups) ? data.groups : []);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setRemote([]);
        setError(t("common.errorLoad", { thing: t("search.hint").toLowerCase() }));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [open, debounced, t]);

  // Build the visible groups: actions (local filter) + pages (local when idle) + remote.
  const groups = useMemo<Group[]>(() => {
    const needle = query.trim().toLowerCase();
    const actions: Item[] = ACTIONS.map((a) => ({ kind: "action" as const, id: a.id, title: t(a.key), subtitle: null, href: a.href })).filter(
      (a) => !needle || a.title.toLowerCase().includes(needle)
    );
    const out: Group[] = [];
    if (actions.length) out.push({ kind: "action", label: t("search.group.actions"), items: actions });
    if (debounced.length < MIN_CHARS) {
      const pages: Item[] = SEARCH_PAGES.map((p) => ({
        kind: "page" as const,
        id: p.href,
        title: p.key ? t(p.key) : p.label,
        subtitle: p.href,
        href: p.href,
      }))
        .filter((p) => !needle || p.title.toLowerCase().includes(needle) || p.href.includes(needle))
        .slice(0, 8);
      if (pages.length) out.push({ kind: "page", label: t("search.group.pages"), items: pages });
    } else {
      out.push(...remote);
    }
    return out;
  }, [query, debounced, remote, t]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(flat.length - 1, 0)));
  }, [flat.length]);

  const go = useCallback(
    (item: Item) => {
      if (item.href === OPEN_COPILOT) {
        window.dispatchEvent(new CustomEvent("javis:open-copilot"));
      } else {
        router.push(item.href);
      }
      close();
    },
    [router, close]
  );

  function onInputKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => (flat.length ? (s + 1) % flat.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => (flat.length ? (s - 1 + flat.length) % flat.length : 0));
    } else if (e.key === "Home") {
      setSelected(0);
    } else if (e.key === "End") {
      setSelected(Math.max(flat.length - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = flat[selected];
      if (item) go(item);
    } else if (e.key === "Tab") {
      // Keep focus inside the dialog: the input is the only focusable control that matters.
      e.preventDefault();
    }
  }

  // Keep the selected row in view.
  useEffect(() => {
    if (!open) return;
    const el = document.getElementById(`${listId}-opt-${selected}`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selected, open, listId]);

  if (!open) return null;

  const showMinHint = query.trim().length > 0 && query.trim().length < MIN_CHARS;
  const empty = !loading && !error && flat.length === 0;
  let index = -1;

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center px-3 pt-[12dvh] sm:px-4" onMouseDown={close}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" aria-hidden />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("search.hint")}
        className="relative z-10 w-full max-w-lg overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-border px-3 py-2.5 sm:px-4">
          {loading ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />
          ) : (
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <input
            ref={inputRef}
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={flat.length ? `${listId}-opt-${selected}` : undefined}
            aria-label={t("search.hint")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            onKeyDown={onInputKey}
            placeholder={t("search.placeholder")}
            className="h-9 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground sm:text-sm"
          />
          <button
            type="button"
            onClick={close}
            aria-label={t("common.close")}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div id={listId} role="listbox" aria-label={t("search.hint")} className="max-h-[min(60dvh,24rem)] overflow-y-auto overscroll-contain py-2">
          <p className="sr-only" aria-live="polite">
            {loading ? t("search.searching") : `${flat.length}`}
          </p>
          {error && (
            <p role="alert" className="mx-3 my-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
          {showMinHint && !loading && (
            <p className="px-4 py-2 text-xs text-muted-foreground">{t("search.minChars", { count: MIN_CHARS })}</p>
          )}
          {empty && !showMinHint && (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t("search.noResults")}</p>
          )}
          {groups.map((group) => (
            <div key={group.kind} role="group" aria-label={group.label}>
              <div className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{group.label}</div>
              {group.items.map((item) => {
                index += 1;
                const i = index;
                const Icon = item.kind === "action" ? (ACTIONS.find((a) => a.id === item.id)?.icon ?? ICONS.action) : ICONS[item.kind];
                const active = selected === i;
                return (
                  <button
                    key={`${item.kind}:${item.id}`}
                    id={`${listId}-opt-${i}`}
                    type="button"
                    role="option"
                    aria-selected={active}
                    tabIndex={-1}
                    onClick={() => go(item)}
                    onMouseEnter={() => setSelected(i)}
                    className={cn(
                      "flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors motion-reduce:transition-none",
                      active ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{item.title}</span>
                      {item.subtitle && <span className="block truncate text-xs text-muted-foreground">{item.subtitle}</span>}
                    </span>
                    <span className="hidden items-center gap-1 text-[11px] text-muted-foreground sm:flex" aria-hidden>
                      <ArrowRight className="h-3 w-3" />
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-4 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
          <span>
            <kbd className="font-mono">↑↓</kbd> {t("search.navigate")}
          </span>
          <span>
            <kbd className="font-mono">↵</kbd> {t("search.openKey")}
          </span>
          <span>
            <kbd className="font-mono">esc</kbd> {t("search.closeKey")}
          </span>
        </div>
      </div>
    </div>
  );
}
