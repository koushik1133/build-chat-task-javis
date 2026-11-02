"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Returns `value` once it has stopped changing for `delay` ms (debounced search inputs). */
export function useDebouncedValue<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

export function isAbortError(err: unknown): boolean {
  return (err instanceof DOMException || err instanceof Error) && err.name === "AbortError";
}

/**
 * Hands out one AbortSignal per request and aborts the previous one, so a slow
 * response can never overwrite a newer one. The in-flight request is aborted on unmount.
 *
 *   const nextSignal = useAbortable();
 *   const load = useCallback(async () => { const signal = nextSignal(); … fetch(url, { signal }) … }, [nextSignal]);
 */
export function useAbortable(): () => AbortSignal {
  const ref = useRef<AbortController | null>(null);
  useEffect(() => () => ref.current?.abort(), []);
  return useCallback(() => {
    ref.current?.abort();
    const ctrl = new AbortController();
    ref.current = ctrl;
    return ctrl.signal;
  }, []);
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);
}

/**
 * Modal behaviour shared by dialogs and drawers: Escape closes, Tab is trapped
 * inside, focus moves in on open and returns to the opener on close, and the
 * page behind stops scrolling. The container needs `tabIndex={-1}`.
 */
export function useModal(
  ref: React.RefObject<HTMLElement | null>,
  onClose: () => void,
  opts: { initialFocus?: "first" | "container" } = {}
) {
  const { initialFocus = "first" } = opts;
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const marked = root.querySelector<HTMLElement>("[data-autofocus]");
    const first = marked ?? focusables(root).find((el) => !el.hasAttribute("data-dialog-close"));
    if (initialFocus === "first" && first) first.focus();
    else root.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !root) return;
      const items = focusables(root);
      if (items.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && root.contains(active);
      if (e.shiftKey && (active === firstEl || !inside)) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && (active === lastEl || !inside)) {
        e.preventDefault();
        firstEl.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      opener?.focus();
    };
  }, [ref, initialFocus]);
}
