"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Pin } from "lucide-react";
import { cn } from "@/lib/utils";

interface Favorite { id: string; label: string; href: string }

/** Sidebar "Pinned" group: the member's favourites. Renders nothing when there are none. */
export function PinnedNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const [items, setItems] = useState<Favorite[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/favorites", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { favorites?: Favorite[] } | null) => {
        if (!cancelled && Array.isArray(d?.favorites)) setItems(d.favorites.slice(0, 8));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  if (items.length === 0) return null;
  return (
    <div>
      <div className="mx-3 my-2.5 border-t border-border" />
      <div className="mb-1 px-3">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Pinned</span>
      </div>
      <nav className="space-y-0.5 px-2" aria-label="Pinned">
        {items.map((f) => {
          const path = f.href.split(/[?#]/)[0];
          const active = pathname === path;
          return (
            <Link
              key={f.id}
              href={f.href}
              onClick={onNavigate}
              title={f.label}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-secondary/70 hover:text-foreground"
              )}
            >
              <Pin className="h-[18px] w-[18px] shrink-0" aria-hidden />
              <span className="truncate">{f.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
