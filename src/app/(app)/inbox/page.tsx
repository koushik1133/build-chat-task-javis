"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCheck, CheckSquare, Clock, MailOpen } from "lucide-react";
import { PageContainer } from "@/components/page-container";
import { Button } from "@/components/ui/button";
import { Empty, ErrorState, SkeletonList } from "@/components/ui/feedback";
import { Pill } from "@/components/ui/pill";
import { CategoryIcon } from "@/components/category-icon";
import { useT } from "@/components/i18n/provider";
import { CATEGORY_LABEL, INBOX_CATEGORIES, filterInbox, type InboxItem } from "@/lib/inbox/pure";
import { cn, timeAgo } from "@/lib/utils";

interface InboxResponse {
  items: InboxItem[];
  next_cursor: string | null;
  unread: number;
  digest: { open_tasks: number; overdue_tasks: number };
  error?: string;
}

async function patch(body: Record<string, unknown>): Promise<boolean> {
  try {
    const r = await fetch("/api/notifications/inbox", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export default function InboxPage() {
  const t = useT();
  const router = useRouter();
  const [items, setItems] = useState<InboxItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const [digest, setDigest] = useState<InboxResponse["digest"] | null>(null);
  const [approvals, setApprovals] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [category, setCategory] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursorId, setCursorId] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const load = useCallback(
    async (after: string | null) => {
      const params = new URLSearchParams({ limit: "30" });
      if (unreadOnly) params.set("unread", "1");
      if (category) params.set("category", category);
      if (after) params.set("cursor", after);
      try {
        const r = await fetch(`/api/notifications/inbox?${params}`, { cache: "no-store" });
        const d = (await r.json().catch(() => null)) as InboxResponse | null;
        if (!r.ok || !d) throw new Error(d?.error ?? `HTTP ${r.status}`);
        setItems((prev) => (after ? [...prev, ...d.items] : d.items));
        setCursor(d.next_cursor);
        setUnread(d.unread);
        setDigest(d.digest);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load inbox.");
      }
    },
    [unreadOnly, category]
  );

  useEffect(() => {
    setLoading(true);
    setSelected(new Set());
    void load(null).finally(() => setLoading(false));
  }, [load]);

  useEffect(() => {
    fetch("/api/approvals?status=pending&count=1", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { count?: number } | null) => setApprovals(d?.count ?? 0))
      .catch(() => setApprovals(0));
  }, []);

  const visible = useMemo(() => filterInbox(items, { unread: unreadOnly, category }), [items, unreadOnly, category]);

  const markRead = useCallback(
    async (ids: string[] | "all") => {
      const ok = await patch(ids === "all" ? { action: "read", all: true } : { action: "read", ids });
      if (!ok) return setError("Could not update notifications.");
      setItems((prev) => prev.map((i) => (ids === "all" || ids.includes(i.id) ? { ...i, read: true } : i)));
      setUnread((u) => (ids === "all" ? 0 : Math.max(0, u - items.filter((i) => ids.includes(i.id) && !i.read).length)));
      setSelected(new Set());
    },
    [items]
  );

  const snooze = useCallback(async (ids: string[], kind: "1h" | "tomorrow") => {
    const ok = await patch({ action: "snooze", ids, snooze: kind, tz_offset: new Date().getTimezoneOffset() });
    if (!ok) return setError("Could not snooze notifications.");
    setItems((prev) => prev.filter((i) => !ids.includes(i.id)));
    setSelected(new Set());
  }, []);

  // Keyboard: j/k move, x select, e mark done (selection or focused row).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (!visible.length) return;
      const idx = Math.max(0, visible.findIndex((i) => i.id === cursorId));
      if (e.key === "j" || e.key === "k") {
        const next = visible[Math.min(visible.length - 1, Math.max(0, idx + (e.key === "j" ? (cursorId ? 1 : 0) : -1)))];
        setCursorId(next.id);
        document.getElementById(`inbox-row-${next.id}`)?.scrollIntoView({ block: "nearest" });
        e.preventDefault();
      } else if (e.key === "x" && cursorId) {
        setSelected((s) => {
          const n = new Set(s);
          if (n.has(cursorId)) n.delete(cursorId);
          else n.add(cursorId);
          return n;
        });
      } else if (e.key === "e") {
        const ids = selected.size ? [...selected] : cursorId ? [cursorId] : [];
        if (ids.length) void markRead(ids);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, cursorId, selected, markRead]);

  function open(i: InboxItem) {
    if (!i.read) void markRead([i.id]);
    if (i.href) router.push(i.href);
  }

  const ids = [...selected];

  return (
    <PageContainer
      title={t("inbox.title")}
      description="Notifications, approvals and work assigned to you, in one place."
      icon={<MailOpen className="h-5 w-5" aria-hidden />}
      actions={
        <Button variant="outline" touch onClick={() => void markRead("all")} disabled={unread === 0}>
          <CheckCheck className="h-4 w-4" aria-hidden /> {t("inbox.markAllRead")}
        </Button>
      }
    >
      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <Link href="/approvals" className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm hover:bg-secondary/40">
          <CheckSquare className="h-4 w-4 text-primary" aria-hidden />
          <span className="min-w-0 flex-1">Pending approvals</span>
          <Pill tone={approvals > 0 ? "warning" : "neutral"}>{approvals}</Pill>
        </Link>
        <Link href="/tasks?mine=1" className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm hover:bg-secondary/40">
          <Clock className="h-4 w-4 text-primary" aria-hidden />
          <span className="min-w-0 flex-1">Assigned to me</span>
          <Pill tone={digest && digest.overdue_tasks > 0 ? "danger" : "neutral"}>
            {digest ? `${digest.open_tasks} open${digest.overdue_tasks ? ` · ${digest.overdue_tasks} overdue` : ""}` : "…"}
          </Pill>
        </Link>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
        <button
          type="button"
          aria-pressed={unreadOnly}
          onClick={() => setUnreadOnly((v) => !v)}
          className={cn("rounded-full border px-3 py-1.5 text-xs font-medium", unreadOnly ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground")}
        >
          {t("inbox.unreadOnly")} {unread > 0 && `(${unread})`}
        </button>
        <button
          type="button"
          aria-pressed={category === null}
          onClick={() => setCategory(null)}
          className={cn("rounded-full border px-3 py-1.5 text-xs font-medium", category === null ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground")}
        >
          {t("inbox.allCategories")}
        </button>
        {INBOX_CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={category === c}
            onClick={() => setCategory(category === c ? null : c)}
            className={cn("inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium", category === c ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground")}
          >
            <CategoryIcon category={c} className="h-3 w-3" /> {CATEGORY_LABEL[c]}
          </button>
        ))}
      </div>

      {ids.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm" role="toolbar" aria-label="Bulk actions">
          <span className="mr-auto">{ids.length} selected</span>
          <Button size="sm" variant="outline" onClick={() => void markRead(ids)}>{t("inbox.done")}</Button>
          <Button size="sm" variant="outline" onClick={() => void snooze(ids, "1h")}>{t("inbox.snooze1h")}</Button>
          <Button size="sm" variant="outline" onClick={() => void snooze(ids, "tomorrow")}>{t("inbox.snoozeTomorrow")}</Button>
        </div>
      )}

      {loading ? (
        <SkeletonList count={5} label="Loading inbox…" />
      ) : error && items.length === 0 ? (
        <ErrorState message={error} onRetry={() => void load(null)} />
      ) : visible.length === 0 ? (
        <Empty icon={<MailOpen className="h-5 w-5" />} title={t("inbox.empty")} text="New notifications show up here. Press ? for keyboard shortcuts." />
      ) : (
        <>
          {error && <p role="alert" className="mb-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
          <p className="mb-1 text-xs text-muted-foreground">j / k move · x select · e mark done</p>
          <ul ref={listRef} className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {visible.map((i) => (
              <li
                key={i.id}
                id={`inbox-row-${i.id}`}
                aria-current={cursorId === i.id ? "true" : undefined}
                className={cn("flex items-start gap-3 px-3 py-3 sm:px-4", !i.read && "bg-primary/5", cursorId === i.id && "ring-2 ring-inset ring-ring")}
              >
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 accent-primary"
                  checked={selected.has(i.id)}
                  onChange={(e) => {
                    setSelected((s) => {
                      const n = new Set(s);
                      if (e.target.checked) n.add(i.id);
                      else n.delete(i.id);
                      return n;
                    });
                  }}
                  aria-label={`Select ${i.title}`}
                />
                <CategoryIcon category={i.category} className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <button type="button" onClick={() => open(i)} onFocus={() => setCursorId(i.id)} className="min-w-0 flex-1 text-left">
                  <span className={cn("block truncate text-sm", !i.read && "font-semibold")}>{i.title}</span>
                  {i.body && <span className="line-clamp-2 text-xs text-muted-foreground">{i.body}</span>}
                  <span className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                    <Pill tone="neutral">{CATEGORY_LABEL[i.category] ?? i.category}</Pill>
                    {timeAgo(i.created_at)}
                  </span>
                </button>
                <div className="flex shrink-0 gap-1">
                  <Button size="sm" variant="ghost" aria-label={`${t("inbox.snooze1h")}: ${i.title}`} title={t("inbox.snooze1h")} onClick={() => void snooze([i.id], "1h")}>
                    <Clock className="h-4 w-4" aria-hidden />
                  </Button>
                  {!i.read && (
                    <Button size="sm" variant="ghost" aria-label={`${t("inbox.done")}: ${i.title}`} title={t("inbox.done")} onClick={() => void markRead([i.id])}>
                      <CheckCheck className="h-4 w-4" aria-hidden />
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {cursor && (
            <div className="mt-4 flex justify-center">
              <Button
                variant="outline"
                touch
                disabled={loadingMore}
                onClick={() => {
                  setLoadingMore(true);
                  void load(cursor).finally(() => setLoadingMore(false));
                }}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </>
      )}
    </PageContainer>
  );
}
