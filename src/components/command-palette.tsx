"use client";

import dynamic from "next/dynamic";

/**
 * Command palette shell. The palette body (search, grouped results, keyboard
 * handling, a dozen icons) is only needed once the user presses ⌘K or taps
 * the search button, so it is code-split and skipped during SSR — it renders
 * nothing until opened anyway. The body still installs its global shortcut
 * listener as soon as the chunk loads on hydration.
 */
const CommandPaletteBody = dynamic(() => import("./command-palette-body"), { ssr: false });

export function CommandPalette() {
  return <CommandPaletteBody />;
}
