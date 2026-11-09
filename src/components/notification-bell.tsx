"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, X } from "lucide-react";
import { cn, timeAgo } from "@/lib/utils";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CategoryIcon } from "@/components/category-icon";

type Notification = {
  id: string;
  title: string;
  body: string | null;
  read: boolean;
  created_at: string;
  /** "outbox" rows come from notification_outbox (in_app channel). */
  source?: "outbox";
  data?: Record<string, unknown> | null;
};

export const NOTIFICATIONS_REFRESH = "javis:notifications-refresh";

type NotificationBellProps = {
  /** inline = toolbar button (Production header). fixed = top-right overlay (all other pages). */
  variant?: "inline" | "fixed";
};

function inferNotificationPath(title: string, body: string | null): string {
  const t = title.toLowerCase();
  const b = (body ?? "").toLowerCase();
  if (t.includes("agent") || b.includes("agent") || b.includes("brief") || b.includes("report")) {
    return "/agents";
  }
  if (t.includes("task") || b.includes("task")) {
    return "/tasks";
  }
  if (t.includes("lead") || b.includes("lead") || t.includes("publish") || b.includes("publish")) {
    return "/analytics";
  }
  if (t.includes("strategy") || b.includes("strategy")) {
    return "/strategy";
  }
  if (t.includes("chat") || b.includes("chat") || t.includes("session") || b.includes("session")) {
    return "/chat";
  }
  if (t.includes("production") || b.includes("production") || t.includes("kanban") || b.includes("kanban")) {
    return "/production";
  }
  return "/agents"; // default destination
}

export function NotificationBell({ variant = "inline" }: NotificationBellProps) {
  const router = useRouter();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [showNotifs, setShowNotifs] = useState(false);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<Notification | null>(null);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const initialLoadRef = useRef(true);
  const panelRef = useRef<HTMLDivElement>(null);

  const showToast = useCallback((n: Notification) => {
    setToast(n);
    setShowNotifs(true);
    window.setTimeout(() => setToast(null), 6000);
  }, []);

  const refresh = useCallback(async (openPanel = false) => {
    setLoading(true);
    try {
      const [res, outboxRes] = await Promise.all([
        fetch("/api/notifications", { cache: "no-store" }),
        fetch("/api/notifications/outbox?unread=1", { cache: "no-store" }).catch(() => null),
      ]);
      const d = await res.json();
      const o = outboxRes && outboxRes.ok ? await outboxRes.json().catch(() => null) : null;
      const outboxList: Notification[] = (o?.notifications ?? []).map((n: Notification) => ({ ...n, source: "outbox" as const }));
      const list: Notification[] = [...outboxList, ...(d.notifications ?? [])]
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      setNotifications(list);
      setUnread((d.unread ?? 0) + (o?.unread ?? 0));

      if (!initialLoadRef.current) {
        const fresh = list.filter(n => !seenIdsRef.current.has(n.id));
        if (fresh.length > 0) {
          showToast(fresh[0]);
        }
      } else {
        initialLoadRef.current = false;
      }
      seenIdsRef.current = new Set(list.map(n => n.id));

      if (openPanel) setShowNotifs(true);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    refresh();

    const onRefresh = (e: Event) => {
      const detail = (e as CustomEvent<Notification | undefined>).detail;
      if (detail?.id) {
        setNotifications(prev => {
          if (prev.some(n => n.id === detail.id)) return prev;
          return [detail, ...prev];
        });
        seenIdsRef.current.add(detail.id);
        setUnread(u => u + 1);
        showToast(detail);
      } else {
        refresh(true);
      }
    };

    window.addEventListener(NOTIFICATIONS_REFRESH, onRefresh);

    const interval = setInterval(() => {
      if (document.visibilityState === "visible") {
        refresh();
      }
    }, 3000);

    return () => {
      window.removeEventListener(NOTIFICATIONS_REFRESH, onRefresh);
      clearInterval(interval);
    };
  }, [refresh, showToast]);

  useEffect(() => {
    if (!showNotifs) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setShowNotifs(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [showNotifs]);

  function markAllRead() {
    fetch("/api/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    });
    fetch("/api/notifications/outbox", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true, read: true }),
    }).catch(() => {});
    setNotifications(n => n.map(x => ({ ...x, read: true })));
    setUnread(0);
  }

  function markRead(id: string, source?: "outbox") {
    fetch(source === "outbox" ? "/api/notifications/outbox" : "/api/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [id], read: true }),
    }).catch(() => {});
    setNotifications(n => n.map(x => x.id === id ? { ...x, read: true } : x));
    setUnread(u => Math.max(0, u - 1));
  }

  const handleNotifClick = (n: Notification) => {
    if (!n.read) {
      markRead(n.id, n.source);
    }
    const link = typeof n.data?.href === "string" && n.data.href.startsWith("/") && !n.data.href.startsWith("//") ? n.data.href : null;
    const path = link ?? inferNotificationPath(n.title, n.body);
    router.push(path);
    setShowNotifs(false);
  };

  const isFixed = variant === "fixed";

  return (
    <>
      {showNotifs && (
        <div
          role="presentation"
          className="fixed inset-0 z-40 bg-transparent"
          onClick={() => setShowNotifs(false)}
        />
      )}

      {/* Toast popup */}
      {toast && (
        <div
          className={cn(
            "fixed right-4 z-[60] w-[min(20rem,calc(100vw-2rem))] rounded-xl border border-border bg-card shadow-2xl animate-in slide-in-from-top-2 fade-in duration-300",
            isFixed ? "top-14 lg:top-16" : "top-20 lg:top-4"
          )}
        >
          <div className="flex items-start gap-3 p-4">
            <div className="rounded-lg bg-primary/10 p-2 shrink-0">
              <Bell className="h-4 w-4 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold">{toast.title}</p>
              {toast.body && (
                <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{toast.body}</p>
              )}
            </div>
            <button
              onClick={() => setToast(null)}
              className="text-muted-foreground hover:text-foreground shrink-0"
              aria-label="Dismiss"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      <div
        ref={panelRef}
        className={cn(
          "relative",
          isFixed && "fixed right-6 top-16 z-50 lg:right-8"
        )}
      >
        <button
          onClick={() => {
            setShowNotifs(v => !v);
            if (!showNotifs) {
              refresh();
              // Outbox (in-app) rows count as read once the panel is opened.
              const outboxUnread = notifications.filter(n => n.source === "outbox" && !n.read);
              if (outboxUnread.length > 0) {
                fetch("/api/notifications/outbox", {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ ids: outboxUnread.map(n => n.id), read: true }),
                }).catch(() => {});
                setNotifications(prev => prev.map(n => n.source === "outbox" ? { ...n, read: true } : n));
                setUnread(u => Math.max(0, u - outboxUnread.length));
              }
            }
          }}
          className={cn(
            "flex items-center justify-center rounded-lg border border-border bg-background text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors relative",
            isFixed ? "h-9 w-9 shadow-md" : "h-7 w-7"
          )}
          title="Notifications"
          aria-label="Notifications"
        >
          {unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
            </span>
          )}
          <Bell className={cn(isFixed ? "h-5 w-5" : "h-4 w-4", loading && "opacity-70")} />
        </button>

        {showNotifs && (
          <div className="absolute right-0 top-full z-50 mt-2 w-[min(20rem,calc(100vw-2rem))] rounded-xl border border-border bg-card shadow-2xl max-h-[min(24rem,70vh)] overflow-hidden flex flex-col animate-in fade-in slide-in-from-top-2 duration-150">
            <div className="flex items-center justify-between px-3 py-2.5 border-b border-border shrink-0">
              <span className="text-sm font-semibold">Notifications</span>
              {unread > 0 && (
                <button
                  className="text-xs text-primary hover:underline"
                  onClick={markAllRead}
                >
                  Mark all read
                </button>
              )}
            </div>
            <div className="overflow-y-auto flex-1">
              {notifications.length === 0 ? (
                <p className="text-xs text-muted-foreground p-6 text-center">No notifications yet</p>
              ) : (
                notifications.slice(0, 20).map(n => (
                  <button
                    key={n.id}
                    onClick={() => handleNotifClick(n)}
                    className={cn(
                      "w-full text-left px-3 py-2.5 border-b border-border/50 last:border-0 hover:bg-secondary/40 transition-colors block",
                      !n.read && "bg-primary/5 font-medium"
                    )}
                  >
                    <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                      <CategoryIcon category={typeof n.data?.category === "string" ? n.data.category : null} className="h-3 w-3 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 truncate">{n.title}</span>
                    </p>
                    {n.body && (
                      <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">{n.body}</p>
                    )}
                    <p className="text-[10px] text-muted-foreground mt-1">{timeAgo(n.created_at)}</p>
                  </button>
                ))
              )}
            </div>
            <Link
              href="/inbox"
              onClick={() => setShowNotifs(false)}
              className="shrink-0 border-t border-border px-3 py-2 text-center text-xs font-medium text-primary hover:bg-secondary/40"
            >
              View all
            </Link>
          </div>
        )}
      </div>
    </>
  );
}

export function dispatchNotificationRefresh(notification?: Notification) {
  window.dispatchEvent(new CustomEvent(NOTIFICATIONS_REFRESH, { detail: notification }));
}
