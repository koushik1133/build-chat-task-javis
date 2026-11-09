import { AREAS, type Area } from "@/lib/auth/roles";

/**
 * API key scopes (client-safe, no DB).
 *
 *   read:<area>   GET on that area's resources
 *   write:<area>  POST/PATCH/DELETE on that area's resources (implies read)
 *   mcp           legacy full-access scope issued before Phase 4; still honoured
 */
export type ReadScope = `read:${Area}`;
export type WriteScope = `write:${Area}`;
export type ApiScope = ReadScope | WriteScope | "mcp";

export const FULL_ACCESS_SCOPE = "mcp" as const;

export const READ_SCOPES: readonly ReadScope[] = AREAS.map((a) => `read:${a}` as const);
export const WRITE_SCOPES: readonly WriteScope[] = AREAS.map((a) => `write:${a}` as const);
export const API_SCOPES: readonly ApiScope[] = [...READ_SCOPES, ...WRITE_SCOPES, FULL_ACCESS_SCOPE];

const SCOPE_SET = new Set<string>(API_SCOPES);

export function isApiScope(v: unknown): v is ApiScope {
  return typeof v === "string" && SCOPE_SET.has(v);
}

export function readScope(area: Area): ReadScope {
  return `read:${area}`;
}
export function writeScope(area: Area): WriteScope {
  return `write:${area}`;
}

/** Split "read:crm" into its parts, or null for anything else (incl. "mcp"). */
export function parseScope(scope: string): { mode: "read" | "write"; area: Area } | null {
  const m = /^(read|write):([a-z]+)$/.exec(scope);
  if (!m) return null;
  if (!(AREAS as readonly string[]).includes(m[2])) return null;
  return { mode: m[1] as "read" | "write", area: m[2] as Area };
}

/**
 * True when `granted` satisfies `needed`. "mcp" grants everything; a write
 * scope grants the matching read scope.
 */
export function hasScope(granted: readonly string[], needed: ApiScope): boolean {
  if (granted.includes(FULL_ACCESS_SCOPE)) return true;
  if (granted.includes(needed)) return true;
  const want = parseScope(needed);
  if (want?.mode === "read") return granted.includes(writeScope(want.area));
  return false;
}

/** Drop unknown/duplicate scopes; keep input order. */
export function normaliseScopes(input: readonly unknown[]): ApiScope[] {
  const out: ApiScope[] = [];
  for (const s of input) {
    if (isApiScope(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

/** Human labels for the scope picker and the developers page. */
export const AREA_LABELS: Record<Area, string> = {
  crm: "Contacts (CRM)",
  leads: "Leads",
  messaging: "Messaging",
  production: "Production",
  tasks: "Tasks",
  social: "Social",
  ads: "Ads",
  sites: "Sites",
  agents: "Agents & automations",
  knowledge: "Knowledge base",
  billing: "Quotes, invoices & products",
  calendar: "Calendar & bookings",
  helpdesk: "Helpdesk tickets",
  reports: "Reports",
  team: "Team, staff & rota",
  settings: "Settings & webhooks",
};

/** Areas that the v1 API currently exposes (others exist for future routes). */
export const API_AREAS: readonly Area[] = ["crm", "tasks", "billing", "calendar", "helpdesk", "knowledge", "agents", "messaging", "reports", "team", "settings"];
