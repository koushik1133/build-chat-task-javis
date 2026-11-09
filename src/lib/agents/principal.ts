import { AREAS, type Area } from "@/lib/auth/roles";
import { parseScope, FULL_ACCESS_SCOPE } from "@/lib/public-api/scopes";

/**
 * The principal an agent run acts for. Persisted on `agent_runs` so queued
 * jobs, resumes after approval and retries keep the triggering caller's
 * permissions (a read-only key can never widen into the owner's matrix).
 * A run with no stored principal (cron, webhooks, playbooks) uses the owner
 * matrix of the org.
 */
export type PrincipalPermissions = Record<Area, { view: boolean; edit: boolean }>;

export interface RunPrincipal {
  role: string;
  permissions: PrincipalPermissions;
}

export function emptyPermissions(): PrincipalPermissions {
  const out = {} as PrincipalPermissions;
  for (const a of AREAS) out[a] = { view: false, edit: false };
  return out;
}

/** Principal from a `requireScope()` result (or anything shaped like it). */
export function principalFromScope(scope: { role: string; permissions: Record<Area, { view: boolean; edit: boolean }> }): RunPrincipal {
  const permissions = emptyPermissions();
  for (const a of AREAS) {
    const p = scope.permissions[a];
    permissions[a] = { view: Boolean(p?.view), edit: Boolean(p?.view && p?.edit) };
  }
  return { role: scope.role, permissions };
}

/** Principal from API key scopes: write:x => view+edit, read:x => view, mcp => everything. */
export function principalFromApiScopes(scopes: readonly string[]): RunPrincipal {
  const permissions = emptyPermissions();
  if (scopes.includes(FULL_ACCESS_SCOPE)) {
    for (const a of AREAS) permissions[a] = { view: true, edit: true };
    return { role: "api_key", permissions };
  }
  for (const s of scopes) {
    const p = parseScope(s);
    if (!p) continue;
    if (p.mode === "write") permissions[p.area] = { view: true, edit: true };
    else if (!permissions[p.area].view) permissions[p.area] = { view: true, edit: false };
  }
  return { role: "api_key", permissions };
}

/** Snapshot a `can` closure (copilot/MCP delegation) into a principal. */
export function principalFromCan(can: (area: Area, edit?: boolean) => boolean, role = "delegated"): RunPrincipal {
  const permissions = emptyPermissions();
  for (const a of AREAS) permissions[a] = { view: can(a), edit: can(a, true) };
  return { role, permissions };
}

/** `can` from a stored JSON matrix. Malformed or missing data denies everything (fail closed). */
export function canFromStored(raw: string | null | undefined): ((area: Area, edit?: boolean) => boolean) | undefined {
  if (raw == null || raw === "") return undefined; // no principal: caller falls back to owner matrix
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return () => false;
  }
  const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, { view?: unknown; edit?: unknown }>) : {};
  return (area, edit = false) => {
    const p = obj[area];
    return Boolean(p && p.view === true && (!edit || p.edit === true));
  };
}

export function serializePrincipal(p: RunPrincipal | null | undefined): { role: string | null; permissions: string | null } {
  if (!p) return { role: null, permissions: null };
  return { role: p.role, permissions: JSON.stringify(p.permissions) };
}
