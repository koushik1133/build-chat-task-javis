/**
 * "Finish setup" checklist — pure derivation from workspace facts.
 * Client-safe (no DB imports).
 */

export const CHECKLIST_KEYS = [
  "profile",
  "pack",
  "contact",
  "quote",
  "booking",
  "team",
  "channel",
  "budget",
] as const;
export type ChecklistKey = (typeof CHECKLIST_KEYS)[number];

export interface ChecklistFacts {
  profileCompleted: boolean;
  packsInstalled: number;
  contacts: number;
  quotes: number;
  activeBookingTypes: number;
  teamMembers: number; // invited or active memberships excluding the owner
  channelsConnected: number;
  aiBudgetSet: boolean;
}

export interface ChecklistItem {
  key: ChecklistKey;
  label: string;
  description: string;
  href: string;
  done: boolean;
}

export interface Checklist {
  items: ChecklistItem[];
  done: number;
  total: number;
  /** 0–100 */
  progress: number;
  complete: boolean;
}

const DEFS: Record<ChecklistKey, { label: string; description: string; href: string }> = {
  profile: { label: "Business profile", description: "Name, industry, currency and timezone.", href: "/onboarding" },
  pack: { label: "Install a records pack", description: "Pick the record types your business tracks.", href: "/r" },
  contact: { label: "Add your first contact", description: "Customers, leads and suppliers live in the CRM.", href: "/crm" },
  quote: { label: "Send your first quote", description: "Quotes turn into invoices when accepted.", href: "/billing" },
  booking: { label: "Publish a booking page", description: "Let customers book time with you.", href: "/calendar" },
  team: { label: "Invite your team", description: "Share the workspace with roles and permissions.", href: "/settings/team" },
  channel: { label: "Connect a channel", description: "Email, SMS, WhatsApp or social accounts.", href: "/settings/integrations" },
  budget: { label: "Set an AI budget", description: "Cap monthly AI spend and pick allowed models.", href: "/settings/ai" },
};

export function deriveChecklist(f: ChecklistFacts): Checklist {
  const done: Record<ChecklistKey, boolean> = {
    profile: f.profileCompleted,
    pack: f.packsInstalled > 0,
    contact: f.contacts > 0,
    quote: f.quotes > 0,
    booking: f.activeBookingTypes > 0,
    team: f.teamMembers > 0,
    channel: f.channelsConnected > 0,
    budget: f.aiBudgetSet,
  };
  const items = CHECKLIST_KEYS.map((key) => ({ key, ...DEFS[key], done: done[key] }));
  const n = items.filter((i) => i.done).length;
  return {
    items,
    done: n,
    total: items.length,
    progress: Math.round((n / items.length) * 100),
    complete: n === items.length,
  };
}

export const EMPTY_FACTS: ChecklistFacts = {
  profileCompleted: false,
  packsInstalled: 0,
  contacts: 0,
  quotes: 0,
  activeBookingTypes: 0,
  teamMembers: 0,
  channelsConnected: 0,
  aiBudgetSet: false,
};
