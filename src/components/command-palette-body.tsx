"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import {
  ArrowLeftRight,
  ArrowRight,
  Archive,
  BookOpen,
  Boxes,
  Building2,
  CalendarClock,
  CalendarDays,
  FileSignature,
  FileText,
  FolderKanban,
  Keyboard,
  LayoutGrid,
  LifeBuoy,
  ListTodo,
  Loader2,
  LogOut,
  MessageSquare,
  Moon,
  Package,
  PieChart,
  Pin,
  Receipt,
  Search,
  Send,
  Settings,
  ShoppingCart,
  Sparkles,
  Star,
  Truck,
  UserPlus,
  UserRound,
  Users,
  Warehouse,
  Wallet,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/components/i18n/provider";
import { OPEN_PALETTE_EVENT } from "@/components/search-button";
import { SEARCH_PAGES } from "@/lib/search/pages";
import type { MessageKey } from "@/lib/i18n";
import { buildGroups, quickActionsFor, type PaletteGroup, type PaletteItem, type Permissions } from "@/lib/search/palette";
import { OPEN_SHORTCUTS_EVENT } from "@/components/global-shortcuts";
import { createClient } from "@/lib/supabase/client";

type Item = PaletteItem;
type Group = PaletteGroup;

const OPEN_COPILOT = "__open-copilot__";
const CMD_PIN = "__pin-page__";
const CMD_WORKSPACE = "__switch-workspace__";
const CMD_DARK = "__toggle-dark__";
const CMD_SIGNOUT = "__sign-out__";
const CMD_SHORTCUTS = "__shortcuts__";
const MIN_CHARS = 2;
const DEBOUNCE_MS = 180;

/** Entity kinds that are remembered in "Recent" when opened. */
const NON_RECENT = new Set(["action", "page", "pinned", "recent", "workspace"]);

const ICONS: Record<string, LucideIcon> = {
  action: Sparkles, page: LayoutGrid, contact: Users, lead: UserPlus, task: ListTodo, quote: FileText, invoice: Receipt,
  booking: CalendarDays, ticket: LifeBuoy, record: Boxes, article: BookOpen, order: ShoppingCart, project: FolderKanban,
  supplier: Truck, purchase_order: Package, bill: Receipt, staff: UserRound, document: FileSignature, campaign: Send,
  audience: Users, sequence: Workflow, product: Boxes, expense: Wallet, message: MessageSquare, automation: Zap,
  report: PieChart, snapshot: Archive, booking_type: CalendarClock, location: Warehouse, transfer: ArrowLeftRight, shipment: Truck, return: Package, workspace: Building2, pinned: Pin, recent: Search,
  receipt: Receipt, "user-plus": UserPlus, "list-todo": ListTodo, "life-buoy": LifeBuoy, "calendar-days": CalendarDays,
  wallet: Wallet, package: Package, "folder-kanban": FolderKanban, send: Send,
};

const SYSTEM_ACTIONS: Array<{ id: string; key: MessageKey; href: string; icon: LucideIcon }> = [
  { id: "copilot", key: "search.action.askCopilot", href: OPEN_COPILOT, icon: Sparkles },
  { id: "settings", key: "search.action.openSettings", href: "/settings/branding", icon: Settings },
  { id: "workspace", key: "search.action.switchWorkspace", href: CMD_WORKSPACE, icon: Building2 },
  { id: "dark", key: "search.action.toggleDark", href: CMD_DARK, icon: Moon },
  { id: "shortcuts", key: "search.action.shortcuts", href: CMD_SHORTCUTS, icon: Keyboard },
  { id: "signout", key: "search.action.signOut", href: CMD_SIGNOUT, icon: LogOut },
];

interface Favorite { id: string; kind: string; entity_id: string | null; label: string; href: string }
interface RecentRow { kind: string; entity_id: string; title: string; href: string }

export default function CommandPaletteBody() {
  const t = useT();
  const router = useRouter();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [remote, setRemote] = useState<Group[]>([]);
  const [partial, setPartial] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [permissions, setPermissions] = useState<Permissions>(null);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [recents, setRecents] = useState<RecentRow[]>([]);
  const [workspaces, setWorkspaces] = useState<Item[] | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setDebounced("");
    setRemote([]);
    setPartial(false);
    setError(null);
    setSelected(0);
    setWorkspaces(null);
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

  // Load capabilities, recents and pins each time the palette opens (all optional: failures just hide the sections).
  const refreshPins = useCallback(() => {
    fetch("/api/favorites", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { favorites?: Favorite[] } | null) => setFavorites(Array.isArray(d?.favorites) ? d.favorites : []))
      .catch(() => setFavorites([]));
  }, []);
  useEffect(() => {
    if (!open) return;
    fetch("/api/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { permissions?: Permissions } | null) => setPermissions(d?.permissions ?? null))
      .catch(() => setPermissions(null));
    fetch("/api/recent?limit=8", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { items?: RecentRow[] } | null) => setRecents(Array.isArray(d?.items) ? d.items : []))
      .catch(() => setRecents([]));
    refreshPins();
  }, [open, refreshPins]);

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
        const data = (await r.json().catch(() => null)) as { groups?: Group[]; partial?: boolean; error?: string } | null;
        if (!r.ok) throw new Error(data?.error ?? `HTTP ${r.status}`);
        setRemote(Array.isArray(data?.groups) ? data.groups : []);
        setPartial(Boolean(data?.partial));
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

  // Build the visible groups: pinned, recent, actions, then pages (idle) or remote results.
  const groups = useMemo<Group[]>(() => {
    if (workspaces) return [{ kind: "workspace", label: t("search.action.switchWorkspace"), items: workspaces }];
    const pinnedItems: Item[] = favorites.map((f) => ({ kind: "pinned", id: f.id, title: f.label, subtitle: f.href, href: f.href, pinnedId: f.id, icon: f.kind }));
    const recentItems: Item[] = recents.map((r) => ({ kind: r.kind, id: r.entity_id, title: r.title, subtitle: null, href: r.href }));
    const pathNow = typeof window === "undefined" ? "" : window.location.pathname;
    const pinnedHere = favorites.find((f) => f.kind === "page" && f.href === pathNow);
    const actions: Item[] = [
      ...SYSTEM_ACTIONS.slice(0, 1).map((a) => ({ kind: "action", id: a.id, title: t(a.key), subtitle: null, href: a.href })),
      ...quickActionsFor(permissions).map((a) => ({ kind: "action", id: a.id, title: t(`search.action.${a.key}` as MessageKey), subtitle: null, href: a.href, icon: a.icon })),
      { kind: "action", id: "pin", title: t(pinnedHere ? "search.action.unpinPage" : "search.action.pinPage"), subtitle: pathNow || null, href: CMD_PIN },
      ...SYSTEM_ACTIONS.slice(1).map((a) => ({ kind: "action", id: a.id, title: t(a.key), subtitle: null, href: a.href })),
    ];
    const pages: Item[] = SEARCH_PAGES.map((p) => ({
      kind: "page",
      id: p.href,
      title: t("search.action.goTo", { page: p.key ? t(p.key) : p.label }),
      subtitle: p.href,
      href: p.href,
    }));
    return buildGroups({
      query,
      remoteActive: debounced.length >= MIN_CHARS,
      pinned: pinnedItems,
      recents: recentItems,
      actions,
      pages,
      remote,
      labels: { pinned: t("search.group.pinned"), recent: t("search.group.recent"), actions: t("search.group.actions"), pages: t("search.group.pages") },
    });
  }, [query, debounced, remote, t, favorites, recents, permissions, workspaces]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(flat.length - 1, 0)));
  }, [flat.length]);

  const togglePin = useCallback(
    async (item: Item) => {
      try {
        if (item.pinnedId) {
          await fetch(`/api/favorites?id=${encodeURIComponent(item.pinnedId)}`, { method: "DELETE" });
        } else {
          const isPage = item.kind === "page";
          await fetch("/api/favorites", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind: isPage ? "page" : item.kind, entity_id: isPage ? null : item.id, label: item.title, href: item.href }),
          });
        }
      } catch {
        /* pins are best-effort */
      }
      refreshPins();
    },
    [refreshPins]
  );

  const go = useCallback(
    async (item: Item) => {
      if (item.kind === "workspace") {
        await fetch("/api/orgs/switch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orgId: item.id }) }).catch(() => null);
        window.location.assign("/home");
        return;
      }
      switch (item.href) {
        case OPEN_COPILOT:
          window.dispatchEvent(new CustomEvent("javis:open-copilot"));
          break;
        case CMD_SHORTCUTS:
          window.dispatchEvent(new CustomEvent(OPEN_SHORTCUTS_EVENT));
          break;
        case CMD_DARK: {
          const next = !document.documentElement.classList.contains("dark");
          document.documentElement.classList.toggle("dark", next);
          try {
            localStorage.setItem("theme", next ? "dark" : "light");
          } catch {
            /* storage blocked */
          }
          break;
        }
        case CMD_SIGNOUT:
          await createClient().auth.signOut().catch(() => null);
          await fetch("/api/auth/signout", { method: "POST" }).catch(() => null);
          window.location.replace("/login?signed_out=1");
          return;
        case CMD_PIN: {
          const path = window.location.pathname;
          const existing = favorites.find((f) => f.kind === "page" && f.href === path);
          const label = SEARCH_PAGES.find((p) => p.href === path)?.label ?? (document.title.split(/[|·–-]/)[0].trim() || path);
          await togglePin({ kind: "page", id: path, title: label, subtitle: null, href: path, pinnedId: existing?.id ?? null });
          break;
        }
        case CMD_WORKSPACE: {
          const d = (await fetch("/api/orgs", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null)) as { orgs?: Array<{ id: string; name: string; role: string }>; activeOrgId?: string } | null;
          setWorkspaces((d?.orgs ?? []).map((o) => ({ kind: "workspace", id: o.id, title: o.name, subtitle: o.id === d?.activeOrgId ? `${o.role} · current` : o.role, href: "#" })));
          setSelected(0);
          return; // stay open on the workspace list
        }
        default: {
          if (!NON_RECENT.has(item.kind)) {
            void fetch("/api/recent", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ kind: item.kind, entity_id: item.id, title: item.title, href: item.href }),
            }).catch(() => null);
          }
          router.push(item.href);
        }
      }
      close();
    },
    [router, close, favorites, togglePin]
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
      if (item) void go(item);
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
          {partial && !loading && <p className="px-4 py-1 text-xs text-amber-700 dark:text-amber-400">{t("search.partial")}</p>}
          {empty && !showMinHint && (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t("search.noResults")}</p>
          )}
          {groups.map((group) => (
            <div key={group.kind} role="group" aria-label={group.label}>
              <div className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{group.label}</div>
              {group.items.map((item) => {
                index += 1;
                const i = index;
                const Icon = (item.icon && ICONS[item.icon]) || (item.kind === "action" ? (SYSTEM_ACTIONS.find((a) => a.id === item.id)?.icon ?? ICONS.action) : ICONS[item.kind]) || LayoutGrid;
                const pinnable = item.kind !== "action" && item.kind !== "workspace" && item.kind !== "recent";
                const active = selected === i;
                return (
                  <div
                    key={`${group.kind}:${item.kind}:${item.id}`}
                    role="presentation"
                    onMouseEnter={() => setSelected(i)}
                    className={cn(
                      "flex min-h-11 w-full items-center gap-1 pr-2 text-sm transition-colors motion-reduce:transition-none",
                      active ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <button
                      id={`${listId}-opt-${i}`}
                      type="button"
                      role="option"
                      aria-selected={active}
                      tabIndex={-1}
                      onClick={() => void go(item)}
                      className="flex min-h-11 min-w-0 flex-1 items-center gap-3 py-2.5 pl-4 text-left"
                    >
                      <Icon className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{item.title}</span>
                        {item.subtitle && <span className="block truncate text-xs text-muted-foreground">{item.subtitle}</span>}
                      </span>
                      <ArrowRight className="hidden h-3 w-3 text-muted-foreground sm:block" aria-hidden />
                    </button>
                    {pinnable && (
                      <button
                        type="button"
                        tabIndex={-1}
                        aria-label={`${item.pinnedId ? t("search.unpin") : t("search.pin")}: ${item.title}`}
                        title={item.pinnedId ? t("search.unpin") : t("search.pin")}
                        onClick={() => void togglePin(item)}
                        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-background"
                      >
                        <Star className={cn("h-4 w-4", item.pinnedId && "fill-current text-amber-500")} aria-hidden />
                      </button>
                    )}
                  </div>
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
