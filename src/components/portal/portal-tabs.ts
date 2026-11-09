export const PORTAL_TABS = ["overview", "bookings", "invoices", "orders", "memberships", "projects", "documents", "files", "support", "messages", "rewards", "privacy"] as const;
export type PortalTabId = (typeof PORTAL_TABS)[number];

export const PORTAL_TAB_LABELS: Record<PortalTabId, string> = {
  overview: "Overview",
  bookings: "Bookings",
  invoices: "Invoices & payments",
  orders: "Orders",
  memberships: "Membership",
  projects: "Projects",
  documents: "Documents",
  files: "Files",
  support: "Support",
  messages: "Messages",
  rewards: "Rewards",
  privacy: "Privacy",
};
