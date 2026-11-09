"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ShortcutsDialog } from "@/components/shortcuts-dialog";
import { resolveKey, shouldIgnore, type Pending } from "@/lib/shortcuts/chord";

export const OPEN_SHORTCUTS_EVENT = "kh:open-shortcuts";

function readEnabled(): boolean {
  try {
    return window.localStorage.getItem("kh_shortcuts") !== "off";
  } catch {
    return true;
  }
}

/** App-wide single-key shortcuts (g/n chords, ?, /). The ⌘K palette lives in command-palette-body. */
export function GlobalShortcuts() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const pending = useRef<Pending>(null);

  useEffect(() => setEnabled(readEnabled()), []);

  const toggle = useCallback((on: boolean) => {
    setEnabled(on);
    try {
      if (on) window.localStorage.removeItem("kh_shortcuts");
      else window.localStorage.setItem("kh_shortcuts", "off");
    } catch {
      /* storage unavailable: keep the in-memory choice */
    }
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // `?` must always be able to open the dialog (to re-enable shortcuts), unless typing.
      const dialogOpen = Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'));
      if (shouldIgnore(e, e.target as HTMLElement | null, dialogOpen)) {
        pending.current = null;
        return;
      }
      if (!enabled && e.key !== "?") return;
      const res = resolveKey(pending.current, e.key, Date.now());
      pending.current = res.pending;
      if (!res.action) return;
      e.preventDefault();
      if (res.action.type === "go") router.push(res.action.href);
      else if (res.action.type === "help") setOpen(true);
      else {
        const field = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="search"], input[data-page-search], input[placeholder*="earch" i]')).find(
          (el) => el.offsetParent !== null && !el.disabled
        );
        field?.focus();
      }
    }
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_SHORTCUTS_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_SHORTCUTS_EVENT, onOpen);
    };
  }, [enabled, router]);

  return open ? <ShortcutsDialog onClose={() => setOpen(false)} enabled={enabled} onToggle={toggle} /> : null;
}
