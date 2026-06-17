"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, X } from "lucide-react";
import { cn, timeAgo } from "@/lib/utils";

type Notification = {
  id: string;
  title: string;
  body: string | null;
  read: boolean;
  created_at: string;
};

export const NOTIFICATIONS_REFRESH = "javis:notifications-refresh";

export function NotificationBell() {
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
      const res = await fetch("/api/notifications", { cache: "no-store" });
      const d = await res.json();
      const list: Notification[] = d.notifications ?? [];
      setNotifications(list);
      setUnread(d.unread ?? 0);

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
    setNotifications(n => n.map(x => ({ ...x, read: true })));
    setUnread(0);
  }

  return (
    <>
      {showNotifs && (
        <div
          className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[2px]"
          aria-hidden
          onClick={() => setShowNotifs(false)}
        />
      )}

      {/* Toast popup */}
      {toast && (
        <div className="fixed top-20 right-4 z-[60] w-[min(20rem,calc(100vw-2rem))] rounded-xl border border-border bg-card shadow-2xl animate-in slide-in-from-top-2 fade-in duration-300 lg:top-4">
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

      <div ref={panelRef} className="relative">
        <button
          onClick={() => {
            if (!showNotifs) refresh();
            setShowNotifs(v => !v);
          }}
          className={cn(
            "relative inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-background transition-colors",
            showNotifs
              ? "bg-secondary text-foreground shadow-sm"
              : "text-muted-foreground hover:bg-secondary/80 hover:text-foreground"
          )}
          title="Notifications"
          aria-expanded={showNotifs}
          aria-label="Notifications"
        >
          <Bell className={cn("h-4 w-4", loading && "opacity-70")} />
          {unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 h-4 min-w-4 px-0.5 rounded-full bg-primary text-[10px] font-bold text-primary-foreground flex items-center justify-center animate-in zoom-in duration-200">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </button>

        {showNotifs && (
          <div className="absolute right-0 top-full z-50 mt-2 w-80 rounded-xl border border-border bg-card shadow-2xl max-h-[min(24rem,70vh)] overflow-hidden flex flex-col animate-in fade-in slide-in-from-top-2 duration-150">
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
                  <div
                    key={n.id}
                    className={cn(
                      "px-3 py-2.5 border-b border-border/50 last:border-0",
                      !n.read && "bg-primary/5"
                    )}
                  >
                    <p className="text-xs font-medium">{n.title}</p>
                    {n.body && (
                      <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">{n.body}</p>
                    )}
                    <p className="text-[10px] text-muted-foreground mt-1">{timeAgo(n.created_at)}</p>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

export function dispatchNotificationRefresh(notification?: Notification) {
  window.dispatchEvent(new CustomEvent(NOTIFICATIONS_REFRESH, { detail: notification }));
}
