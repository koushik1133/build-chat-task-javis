/** Pure command-palette helpers (client-safe): quick-action gating and result grouping. */
import type { Area } from "@/lib/auth/roles";

export interface PaletteItem {
  kind: string;
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
  icon?: string;
  /** Favourite id when this entity/page is pinned. */
  pinnedId?: string | null;
}

export interface PaletteGroup {
  kind: string;
  label: string;
  items: PaletteItem[];
}

export interface QuickAction {
  id: string;
  /** i18n key suffix under search.action.* */
  key: string;
  href: string;
  area: Area;
  icon: string;
}

/** Create-actions; each is only offered when the caller can edit the owning area. */
export const QUICK_ACTIONS: QuickAction[] = [
  { id: "new-quote", key: "newQuote", href: "/billing?new=quote", area: "billing", icon: "receipt" },
  { id: "new-invoice", key: "newInvoice", href: "/billing?new=invoice", area: "billing", icon: "receipt" },
  { id: "new-contact", key: "newContact", href: "/crm?new=contact", area: "crm", icon: "user-plus" },
  { id: "new-task", key: "newTask", href: "/tasks?new=task", area: "tasks", icon: "list-todo" },
  { id: "new-ticket", key: "newTicket", href: "/helpdesk?new=ticket", area: "helpdesk", icon: "life-buoy" },
  { id: "new-booking", key: "newBooking", href: "/calendar?new=booking", area: "calendar", icon: "calendar-days" },
  { id: "new-expense", key: "newExpense", href: "/finance?new=expense", area: "billing", icon: "wallet" },
  { id: "new-po", key: "newPo", href: "/procurement?new=po", area: "billing", icon: "package" },
  { id: "new-project", key: "newProject", href: "/projects?new=project", area: "tasks", icon: "folder-kanban" },
  { id: "new-campaign", key: "newCampaign", href: "/marketing?tab=campaigns&new=1", area: "crm", icon: "send" },
];

export type Permissions = Partial<Record<Area, { view?: boolean; edit?: boolean }>> | null | undefined;

/** Quick actions the caller may use. Unknown permissions (not loaded yet) show none. */
export function quickActionsFor(permissions: Permissions): QuickAction[] {
  if (!permissions) return [];
  return QUICK_ACTIONS.filter((a) => permissions[a.area]?.edit === true);
}

const hit = (it: PaletteItem, needle: string) =>
  !needle || it.title.toLowerCase().includes(needle) || (it.subtitle ?? "").toLowerCase().includes(needle) || it.href.toLowerCase().includes(needle);

export interface BuildInput {
  /** Raw typed query. */
  query: string;
  /** True once the debounced query is long enough for remote results. */
  remoteActive: boolean;
  pinned: PaletteItem[];
  recents: PaletteItem[];
  actions: PaletteItem[];
  pages: PaletteItem[];
  remote: PaletteGroup[];
  labels: { pinned: string; recent: string; actions: string; pages: string };
}

/**
 * Order: Pinned, Recent, Actions, then Pages (idle) or remote results (searching).
 * Recents already pinned are dropped; remote items that are pinned are starred.
 */
export function buildGroups(i: BuildInput): PaletteGroup[] {
  const needle = i.query.trim().toLowerCase();
  const pinnedByHref = new Map(i.pinned.map((p) => [p.href, p.pinnedId ?? null]));
  const out: PaletteGroup[] = [];
  const push = (kind: string, label: string, items: PaletteItem[]) => {
    if (items.length) out.push({ kind, label, items });
  };
  const operator = /(^|\s)(kind|in):/i.test(needle);
  const pinned = i.pinned.filter((p) => hit(p, needle));
  push("pinned", i.labels.pinned, pinned);
  push("recent", i.labels.recent, i.recents.filter((r) => !pinnedByHref.has(r.href) && hit(r, needle)).slice(0, 8));
  if (!operator) push("action", i.labels.actions, i.actions.filter((a) => hit(a, needle)));
  if (!i.remoteActive) push("page", i.labels.pages, i.pages.filter((p) => hit(p, needle)).slice(0, 8));
  else
    for (const g of i.remote) {
      push(g.kind, g.label, g.items.map((it) => (pinnedByHref.has(it.href) ? { ...it, pinnedId: pinnedByHref.get(it.href) } : it)));
    }
  return out;
}
