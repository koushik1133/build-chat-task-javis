"use client";

import { Search } from "lucide-react";
import { useT } from "@/components/i18n/provider";
import { cn } from "@/lib/utils";

/** Fired by SearchButton (and anyone else) to open the command palette. */
export const OPEN_PALETTE_EVENT = "kh:command-palette";

export function openCommandPalette() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT, { detail: { open: true } }));
}

/**
 * Top-bar trigger for the command palette. Looks like a search field on wide
 * screens and collapses to an icon button on phones.
 */
export function SearchButton({ className }: { className?: string }) {
  const t = useT();
  const label = t("search.hint");
  return (
    <button
      type="button"
      onClick={openCommandPalette}
      aria-label={label}
      aria-keyshortcuts="Meta+K Control+K"
      className={cn(
        "inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "w-9 justify-center px-0 sm:w-auto sm:justify-start sm:px-3",
        className
      )}
    >
      <Search className="h-4 w-4 shrink-0" aria-hidden />
      <span className="hidden text-sm sm:inline">{t("search.placeholder")}</span>
      <kbd
        aria-hidden
        className="ml-2 hidden rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline"
      >
        ⌘K
      </kbd>
    </button>
  );
}
