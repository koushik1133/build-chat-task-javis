export const PORTAL_TABS = ["overview", "bookings", "invoices", "orders", "projects", "documents", "files", "support", "messages", "privacy"] as const;
export type PortalTabId = (typeof PORTAL_TABS)[number];

export const PORTAL_TAB_LABELS: Record<PortalTabId, string> = {
  overview: "Overview",
  bookings: "Bookings",
  invoices: "Invoices & payments",
  orders: "Orders",
  projects: "Projects",
  documents: "Documents",
  files: "Files",
  support: "Support",
  messages: "Messages",
  privacy: "Privacy",
};
