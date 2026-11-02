import { APP_NAV } from "@/lib/app-nav";
import type { Area } from "@/lib/auth/roles";
import type { MessageKey } from "@/lib/i18n";
import { navKeyFor } from "@/lib/i18n/nav";

/** A navigable app page for search / the command palette. */
export interface SearchPage {
  href: string;
  /** Catalog key when the label is translatable. */
  key: MessageKey | null;
  /** Static English label (fallback). */
  label: string;
  /** Permission area the page belongs to; null = everyone. */
  area: Area | null;
}

/** Longest-prefix map from href to the permission area that gates it. */
const AREA_BY_PREFIX: Array<[string, Area]> = [
  ["/settings/team", "team"],
  ["/settings/audit", "settings"],
  ["/settings/outbox", "settings"],
  ["/settings/api-keys", "settings"],
  ["/settings/branding", "settings"],
  ["/settings/ai", "settings"],
  ["/settings/integrations", "settings"],
  ["/crm", "crm"],
  ["/leads", "leads"],
  ["/messaging", "messaging"],
  ["/production", "production"],
  ["/tasks", "tasks"],
  ["/social", "social"],
  ["/ads", "ads"],
  ["/build", "sites"],
  ["/agents", "agents"],
  ["/automations", "agents"],
  ["/approvals", "agents"],
  ["/files", "knowledge"],
  ["/kb", "knowledge"],
  ["/knowledge", "knowledge"],
  ["/r", "crm"],
  ["/billing", "billing"],
  ["/calendar", "calendar"],
  ["/helpdesk", "helpdesk"],
  ["/analytics", "reports"],
];

export function areaForHref(href: string): Area | null {
  const clean = href.split(/[?#]/)[0];
  let best: [string, Area] | null = null;
  for (const entry of AREA_BY_PREFIX) {
    const [prefix] = entry;
    if ((clean === prefix || clean.startsWith(prefix + "/")) && (!best || prefix.length > best[0].length)) best = entry;
  }
  return best ? best[1] : null;
}

const EXTRA: Array<{ href: string; label: string }> = [
  { href: "/settings/branding", label: "Branding" },
  { href: "/settings/integrations", label: "Connections" },
  { href: "/helpdesk", label: "Helpdesk" },
  { href: "/knowledge", label: "Knowledge Base" },
  { href: "/r", label: "Records" },
];

/** Static list of app routes (sidebar + a few settings pages), deduplicated by href. */
export const SEARCH_PAGES: SearchPage[] = (() => {
  const seen = new Set<string>();
  const out: SearchPage[] = [];
  for (const item of [...APP_NAV.map((n) => ({ href: n.href, label: n.label })), ...EXTRA]) {
    if (seen.has(item.href)) continue;
    seen.add(item.href);
    out.push({ href: item.href, key: navKeyFor(item.href), label: item.label, area: areaForHref(item.href) });
  }
  return out;
})();
