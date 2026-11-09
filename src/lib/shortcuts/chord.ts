/**
 * Keyboard shortcut chord parser (pure, no DOM). `g` then a letter navigates,
 * `n` then a letter opens a create dialog; the second key must arrive within
 * CHORD_WINDOW_MS of the first.
 */

export const CHORD_WINDOW_MS = 1200;

export const GO_MAP: Record<string, { href: string; label: string }> = {
  h: { href: "/home", label: "Home" },
  c: { href: "/crm", label: "CRM" },
  t: { href: "/tasks", label: "Tasks" },
  b: { href: "/billing", label: "Billing" },
  i: { href: "/inventory", label: "Inventory" },
  p: { href: "/projects", label: "Projects" },
  s: { href: "/settings", label: "Settings" },
};

export const NEW_MAP: Record<string, { href: string; label: string }> = {
  q: { href: "/billing?new=quote", label: "New quote" },
  c: { href: "/crm?new=contact", label: "New contact" },
  t: { href: "/tasks?new=task", label: "New task" },
};

export type Pending = { prefix: "g" | "n"; at: number } | null;

export type ShortcutAction =
  | { type: "go"; href: string }
  | { type: "help" }
  | { type: "focus-search" };

export interface ChordResult {
  pending: Pending;
  action: ShortcutAction | null;
}

/** Feed one key press (already filtered for modifiers/typing) and get the next state + action. */
export function resolveKey(pending: Pending, key: string, now: number): ChordResult {
  const k = key.length === 1 ? key.toLowerCase() : key;
  const live = pending && now - pending.at <= CHORD_WINDOW_MS ? pending : null;
  if (live) {
    const map = live.prefix === "g" ? GO_MAP : NEW_MAP;
    const hit = map[k];
    if (hit) return { pending: null, action: { type: "go", href: hit.href } };
    // A non-matching key cancels the chord; fall through so it is still interpreted normally.
  }
  if (k === "g" || k === "n") return { pending: { prefix: k, at: now }, action: null };
  if (key === "?") return { pending: null, action: { type: "help" } };
  if (key === "/") return { pending: null, action: { type: "focus-search" } };
  return { pending: null, action: null };
}

/** True when the key event should be ignored (typing in a field, modifiers held). */
export function shouldIgnore(e: { metaKey: boolean; ctrlKey: boolean; altKey: boolean }, target: { tagName?: string; isContentEditable?: boolean } | null, dialogOpen: boolean): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return true;
  if (dialogOpen) return true;
  const tag = target?.tagName?.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return Boolean(target?.isContentEditable);
}

export const SHORTCUT_ROWS: Array<{ keys: string[]; label: string }> = [
  { keys: ["⌘/Ctrl", "K"], label: "Open the command palette" },
  { keys: ["?"], label: "Show this list" },
  { keys: ["/"], label: "Focus the page search" },
  ...Object.entries(GO_MAP).map(([k, v]) => ({ keys: ["g", k], label: `Go to ${v.label}` })),
  ...Object.entries(NEW_MAP).map(([k, v]) => ({ keys: ["n", k], label: v.label })),
  { keys: ["j", "k"], label: "Move through the inbox" },
  { keys: ["x"], label: "Select inbox item" },
  { keys: ["e"], label: "Mark inbox item done" },
  { keys: ["Esc"], label: "Close dialogs" },
];
