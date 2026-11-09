"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Infinite-scroll footer for keyset-paginated lists (`?cursor=&limit=`).
 *
 *  - An IntersectionObserver sentinel requests the next page when it scrolls
 *    into view; the explicit button is the keyboard / reduced-data fallback.
 *  - The visible count is announced through `aria-live="polite"` so screen
 *    reader users hear "Showing 100 of many" after each page lands.
 *
 * Usage:
 *   <LoadMore hasMore={Boolean(cursor)} loading={loadingMore} count={rows.length} onMore={loadMore} noun="contacts" />
 */
export function LoadMore({
  hasMore,
  loading,
  count,
  onMore,
  noun = "items",
  className,
  auto = true,
}: {
  hasMore: boolean;
  loading: boolean;
  /** Rows currently rendered. */
  count: number;
  onMore: () => void | Promise<void>;
  /** Plural noun for the live-region text. */
  noun?: string;
  className?: string;
  /** Disable the IntersectionObserver (manual button only). */
  auto?: boolean;
}) {
  const sentinel = useRef<HTMLDivElement | null>(null);
  const onMoreRef = useRef(onMore);
  onMoreRef.current = onMore;

  useEffect(() => {
    if (!auto || !hasMore || loading) return;
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void onMoreRef.current();
      },
      { rootMargin: "240px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [auto, hasMore, loading, count]);

  return (
    <div className={cn("flex flex-col items-center gap-2 py-3", className)}>
      <p aria-live="polite" className="text-xs text-muted-foreground tabular-nums">
        Showing {count} {noun}
        {hasMore ? " · more available" : count > 0 ? " · end of list" : ""}
      </p>
      {hasMore && (
        <Button variant="outline" size="sm" touch onClick={() => void onMore()} disabled={loading} aria-busy={loading || undefined}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : null}
          {loading ? "Loading…" : "Load more"}
        </Button>
      )}
      <div ref={sentinel} aria-hidden className="h-px w-full" />
    </div>
  );
}

export interface PagedState<T> {
  rows: T[];
  cursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
}

/**
 * Small state machine for cursor-paginated fetches. `fetchPage(cursor)` must
 * return the page rows and the next cursor. `reload()` fetches the first page
 * (used when filters change); `more()` appends the next one. Requests that
 * are superseded (filters changed mid-flight) are ignored.
 */
export function usePagedList<T>(fetchPage: (cursor: string | null) => Promise<{ rows: T[]; next_cursor: string | null }>): PagedState<T> & {
  reload: () => Promise<void>;
  more: () => Promise<void>;
  setRows: React.Dispatch<React.SetStateAction<T[]>>;
} {
  const [rows, setRows] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gen = useRef(0);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;

  const reload = useCallback(async () => {
    const my = ++gen.current;
    setLoading(true);
    setError(null);
    try {
      const r = await fetchRef.current(null);
      if (my !== gen.current) return;
      setRows(r.rows);
      setCursor(r.next_cursor);
    } catch (e) {
      if (my !== gen.current) return;
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : "Could not load.");
    } finally {
      if (my === gen.current) setLoading(false);
    }
  }, []);

  const more = useCallback(async () => {
    if (!cursor || loadingMore) return;
    const my = gen.current;
    setLoadingMore(true);
    try {
      const r = await fetchRef.current(cursor);
      if (my !== gen.current) return;
      setRows((prev) => {
        const seen = new Set(prev.map((x) => (x as { id?: unknown }).id));
        return [...prev, ...r.rows.filter((x) => !seen.has((x as { id?: unknown }).id))];
      });
      setCursor(r.next_cursor);
    } catch (e) {
      if (my !== gen.current) return;
      setError(e instanceof Error ? e.message : "Could not load more.");
    } finally {
      if (my === gen.current) setLoadingMore(false);
    }
  }, [cursor, loadingMore]);

  return { rows, cursor, loading, loadingMore, error, reload, more, setRows };
}
