/**
 * Role × area permission matrix.
 *
 * Areas map to product modules; roles are ordered from most to least
 * privileged. Orgs may override individual cells via `role_area_overrides`.
 */
export const ROLES = ["owner", "admin", "manager", "member", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const AREAS = [
  "crm",
  "leads",
  "messaging",
  "production",
  "tasks",
  "social",
  "ads",
  "sites",
  "agents",
  "knowledge",
  "billing",
  "calendar",
  "helpdesk",
  "reports",
  "team",
  "settings",
] as const;
export type Area = (typeof AREAS)[number];

export interface AreaPermission {
  view: boolean;
  edit: boolean;
}

const ALL_EDIT: AreaPermission = { view: true, edit: true };
const VIEW_ONLY: AreaPermission = { view: true, edit: false };
const NONE: AreaPermission = { view: false, edit: false };

/** Default matrix. Owner/admin can do everything; others are scoped. */
export const DEFAULT_MATRIX: Record<Role, Record<Area, AreaPermission>> = {
  owner: Object.fromEntries(AREAS.map((a) => [a, ALL_EDIT])) as Record<Area, AreaPermission>,
  admin: Object.fromEntries(AREAS.map((a) => [a, ALL_EDIT])) as Record<Area, AreaPermission>,
  manager: {
    crm: ALL_EDIT, leads: ALL_EDIT, messaging: ALL_EDIT, production: ALL_EDIT, tasks: ALL_EDIT,
    social: ALL_EDIT, ads: ALL_EDIT, sites: ALL_EDIT, agents: ALL_EDIT, knowledge: ALL_EDIT,
    billing: ALL_EDIT, calendar: ALL_EDIT, helpdesk: ALL_EDIT, reports: VIEW_ONLY,
    team: VIEW_ONLY, settings: NONE,
  },
  member: {
    crm: ALL_EDIT, leads: ALL_EDIT, messaging: ALL_EDIT, production: ALL_EDIT, tasks: ALL_EDIT,
    social: ALL_EDIT, ads: VIEW_ONLY, sites: VIEW_ONLY, agents: VIEW_ONLY, knowledge: ALL_EDIT,
    billing: VIEW_ONLY, calendar: ALL_EDIT, helpdesk: ALL_EDIT, reports: NONE,
    team: NONE, settings: NONE,
  },
  viewer: {
    crm: VIEW_ONLY, leads: VIEW_ONLY, messaging: VIEW_ONLY, production: VIEW_ONLY, tasks: VIEW_ONLY,
    social: VIEW_ONLY, ads: VIEW_ONLY, sites: VIEW_ONLY, agents: VIEW_ONLY, knowledge: VIEW_ONLY,
    billing: VIEW_ONLY, calendar: VIEW_ONLY, helpdesk: VIEW_ONLY, reports: NONE,
    team: NONE, settings: NONE,
  },
};

export function isRole(v: unknown): v is Role {
  return typeof v === "string" && (ROLES as readonly string[]).includes(v);
}
export function isArea(v: unknown): v is Area {
  return typeof v === "string" && (AREAS as readonly string[]).includes(v);
}

/** True when `actor` may assign/change `target` (never escalate above yourself). */
export function canManageRole(actor: Role, target: Role): boolean {
  if (actor === "owner") return true;
  if (actor === "admin") return target !== "owner";
  return false;
}
