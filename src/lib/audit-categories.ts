/** Audit entity -> category map (client-safe, pure). */

export const AUDIT_CATEGORIES = ["access", "data", "integrations", "billing", "content", "operations", "other"] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export const AUDIT_CATEGORY_LABELS: Record<AuditCategory, string> = {
  access: "Access & security",
  data: "Data & privacy",
  integrations: "Integrations",
  billing: "Billing & payments",
  content: "Content & records",
  operations: "Operations & alerts",
  other: "Other",
};

const ENTITIES: Record<Exclude<AuditCategory, "other">, string[]> = {
  access: ["api_key", "scim_token", "sso_domain", "member_role", "member", "security_incident", "crew_link", "workspace", "client_workspace"],
  data: ["snapshot", "dsr_request", "retention_policy", "privacy_notice", "import", "export", "attachment"],
  integrations: ["webhook", "chat_integration", "accounting_connection", "calendar_connection", "marketplace_install", "marketplace_listing"],
  billing: ["refund", "order", "payroll", "invoice", "quote", "payment", "plan"],
  content: ["document", "document_template", "email_template", "campaign", "sequence", "audience", "site", "storefront", "project", "tasks", "saved_report", "report_schedule", "dashboard"],
  operations: ["alert_rule", "automation", "shift", "shift_swap", "leave_request", "leave_balance", "attendance", "staff_profile", "portal_message"],
};

export function categoryOf(entity: string): AuditCategory {
  for (const c of Object.keys(ENTITIES) as Array<Exclude<AuditCategory, "other">>) if (ENTITIES[c].includes(entity)) return c;
  return "other";
}

export function isAuditCategory(v: unknown): v is AuditCategory {
  return typeof v === "string" && (AUDIT_CATEGORIES as readonly string[]).includes(v);
}

/** Entities of a category; `other` returns null (callers use "NOT IN all known"). */
export function entitiesOf(category: AuditCategory): string[] | null {
  return category === "other" ? null : ENTITIES[category];
}

export function allKnownEntities(): string[] {
  return Object.values(ENTITIES).flat();
}
