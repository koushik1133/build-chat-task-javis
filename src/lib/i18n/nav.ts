/**
 * Sidebar label translation without touching app-nav.ts.
 *
 * `navKeyFor(href)` maps a nav href to a catalog key; `navLabel(href, t, fallback)`
 * resolves it through a bound translator (from `useT()` or `makeT()`), falling
 * back to the static English label when an href has no key yet.
 */
import type { MessageKey, TVars } from "./index";

const NAV_KEYS: Record<string, MessageKey> = {
  "/home": "nav.home",
  "/chat": "nav.chat",
  "/files": "nav.files",
  "/github": "nav.github",
  "/social": "nav.social",
  "/build": "nav.build",
  "/messaging": "nav.messaging",
  "/leads": "nav.leads",
  "/crm": "nav.crm",
  "/calendar": "nav.calendar",
  "/ads": "nav.ads",
  "/analytics": "nav.analytics",
  "/strategy": "nav.strategy",
  "/agency": "nav.agency",
  "/agency/clients": "nav.agency.clients",
  "/production": "nav.production",
  "/tasks": "nav.tasks",
  "/billing": "nav.billing",
  "/inventory": "nav.inventory",
  "/procurement": "nav.procurement",
  "/workforce": "nav.workforce",
  "/finance": "nav.finance",
  "/reports": "nav.reports",
  "/agents": "nav.agents",
  "/agents/swarms": "nav.agents.swarms",
  "/automations": "nav.automations",
  "/approvals": "nav.approvals",
  "/settings": "nav.settings",
  "/settings/ai": "nav.settings.ai",
  "/settings/team": "nav.settings.team",
  "/settings/audit": "nav.settings.audit",
  "/settings/outbox": "nav.settings.outbox",
  "/settings/api-keys": "nav.settings.apiKeys",
  "/settings/branding": "nav.settings.branding",
  "/settings/import": "nav.settings.import",
  "/settings/notifications": "nav.settings.notifications",
  "/settings/integrations": "nav.settings.integrations",
  "/settings/sso": "nav.settings.sso",
  "/insights": "nav.insights",
  "/settings/webhooks": "nav.settings.webhooks",
  "/settings/widgets": "nav.settings.widgets",
  "/settings/system": "nav.settings.system",
  "/settings/developers": "nav.settings.developers",
  "/settings/mail": "nav.settings.mail",
  "/settings/accounting": "nav.settings.accounting",
  "/settings/privacy": "nav.settings.privacy",
  "/voice": "nav.voice",
  "/helpdesk": "nav.helpdesk",
  "/documents": "nav.documents",
  "/marketplace": "nav.marketplace",
  "/kb": "nav.kb",
  "/knowledge": "nav.kb",
  "/r": "nav.records",
  "/domains/healthcare": "nav.domains.healthcare",
  "/domains/education": "nav.domains.education",
  "/domains/legal": "nav.domains.legal",
  "/domains/finance": "nav.domains.finance",
  "/domains/realestate": "nav.domains.realestate",
  "/domains/ecommerce": "nav.domains.ecommerce",
  "/domains/nonprofit": "nav.domains.nonprofit",
  "/domains/business": "nav.domains.business",
  "/domains/request": "nav.domains.request",
};

/** Sidebar group headings (app-nav.ts `title`) → catalog key. */
const GROUP_KEYS: Record<string, MessageKey> = {
  "Channels": "nav.group.channels",
  "Create & Publish": "nav.group.create",
  "Engage": "nav.group.engage",
  "Grow": "nav.group.grow",
  "Operate": "nav.group.operate",
  "Automate": "nav.group.automate",
  "Domain Hubs": "nav.group.domains",
};

export type Translator = (key: MessageKey, vars?: TVars) => string;

/** Catalog key for an href (exact match, then longest prefix), or null. */
export function navKeyFor(href: string): MessageKey | null {
  const clean = href.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  if (NAV_KEYS[clean]) return NAV_KEYS[clean];
  let best: string | null = null;
  for (const k of Object.keys(NAV_KEYS)) {
    if (clean.startsWith(k + "/") && (!best || k.length > best.length)) best = k;
  }
  return best ? NAV_KEYS[best] : null;
}

/** Translated sidebar label for an href; `fallback` is the static English label. */
export function navLabel(href: string, t: Translator, fallback = ""): string {
  const key = navKeyFor(href);
  return key ? t(key) : fallback || href;
}

/** Translated group heading; unknown titles pass through unchanged. */
export function navGroupLabel(title: string, t: Translator): string {
  const key = GROUP_KEYS[title];
  return key ? t(key) : title;
}
