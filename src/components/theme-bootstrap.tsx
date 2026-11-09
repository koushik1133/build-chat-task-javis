"use client";

import { useLayoutEffect } from "react";

/** Same rule as the inline script in the root layout. Exported so the two can never drift. */
export function applyStoredTheme() {
  try {
    const stored = localStorage.getItem("theme");
    const dark = stored === "dark" || (!stored && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  } catch {
    /* storage blocked: leave the light default */
  }
}

/**
 * Client-side fallback for the theme bootstrap.
 *
 * The inline `<script>` in the root layout runs before first paint on a normal
 * server render. When a layout throws `notFound()`, though, Next serves the bare
 * `__next_error__` shell and client-renders the not-found tree — and React does
 * not execute inline scripts it inserts itself, so the page would stay light.
 * Running the same rule once on mount closes that gap; it is a no-op when the
 * inline script already applied the class.
 */
export function ThemeBootstrap() {
  useLayoutEffect(() => {
    applyStoredTheme();
  }, []);
  return null;
}
