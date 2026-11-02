import { query, queryOne } from "@/lib/dsql";
import { ROLES, isRole, type Role } from "@/lib/auth/roles";
import { AlreadyMemberError, createInvite, sendInviteEmail } from "@/lib/team";
import type { ScimContext } from "./auth";
import { applyUserPatch, matchesFilter, type PatchOp, type PatchableUser, type ScimFilter, type ScimGroup, type ScimUser, SCIM } from "./schema";

/**
 * SCIM Users/Groups over the memberships table.
 *
 *  - User id        = membership id
 *  - userName       = invited_email (set on invite; backfilled on accept)
 *  - active         = status ∈ {active, invited}; deactivating sets `removed`
 *  - roles[0].value = role; Groups are the fixed role set (id "role:<role>")
 *
 * Provisioning creates an invited membership and queues the invite email
 * through the outbox; the user accepts it with their IdP-backed sign-in.
 */

export class ScimRequestError extends Error {
  constructor(public readonly status: number, message: string, public readonly scimType?: "uniqueness" | "mutability" | "invalidValue" | "invalidSyntax" | "noTarget" | "invalidPath") {
    super(message);
    this.name = "ScimRequestError";
  }
}

interface MembershipRow {
  id: string;
  user_id: string | null;
  role: string;
  status: string;
  invited_email: string | null;
  display_name: string | null;
  created_at: string;
  updated_at: string | null;
}

const COLS = "id, user_id, role, status, invited_email, NULL::text AS display_name, created_at, updated_at";

export function roleFromScim(roles: unknown): Role | null {
  const first = Array.isArray(roles) ? roles[0] : roles;
  const v = first && typeof first === "object" ? (first as { value?: unknown }).value : first;
  if (typeof v !== "string") return null;
  const lower = v.trim().toLowerCase();
  return isRole(lower) ? lower : null;
}

export function groupId(role: Role): string {
  return `role:${role}`;
}
export function roleFromGroupId(id: string): Role | null {
  const r = id.startsWith("role:") ? id.slice(5) : id;
  return isRole(r) ? r : null;
}

export function toScimUser(r: MembershipRow, baseUrl: string): ScimUser {
  const email = (r.invited_email ?? "").toLowerCase();
  const role = isRole(r.role) ? r.role : "member";
  return {
    schemas: [SCIM.USER],
    id: r.id,
    userName: email,
    active: r.status === "active" || r.status === "invited",
    displayName: r.display_name ?? undefined,
    emails: email ? [{ value: email, primary: true, type: "work" }] : [],
    roles: [{ value: role, primary: true }],
    groups: [{ value: groupId(role), display: groupName(role) }],
    meta: { resourceType: "User", created: r.created_at, lastModified: r.updated_at ?? r.created_at, location: `${baseUrl}/Users/${r.id}` },
  };
}

export function groupName(role: Role): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

async function loadMembership(orgId: string, id: string): Promise<MembershipRow | null> {
  return queryOne<MembershipRow>(`SELECT ${COLS} FROM memberships WHERE id = $1 AND org_id = $2 AND status <> 'removed'`, [id, orgId]);
}

export async function listScimUsers(
  ctx: ScimContext,
  opts: { filter: ScimFilter | null; startIndex: number; count: number; baseUrl: string }
): Promise<{ users: ScimUser[]; total: number }> {
  const params: unknown[] = [ctx.orgId];
  let where = `org_id = $1 AND status IN ('active', 'invited')`;
  // userName / emails eq is the lookup every IdP makes before create; push it to SQL.
  const f = opts.filter;
  if (f && f.op === "eq" && typeof f.value === "string" && (f.attr === "username" || f.attr === "emails.value" || f.attr === "emails")) {
    params.push(f.value.toLowerCase());
    where += ` AND LOWER(invited_email) = $${params.length}`;
  }
  const rows = await query<MembershipRow>(`SELECT ${COLS} FROM memberships WHERE ${where} ORDER BY created_at ASC LIMIT 1000`, params);
  let users = rows.map((r) => toScimUser(r, opts.baseUrl));
  if (f && !(f.op === "eq" && (f.attr === "username" || f.attr === "emails.value" || f.attr === "emails"))) {
    users = users.filter((u) => matchesFilter(u, f));
  }
  const total = users.length;
  return { users: users.slice(opts.startIndex - 1, opts.startIndex - 1 + opts.count), total };
}

export async function getScimUser(ctx: ScimContext, id: string, baseUrl: string): Promise<ScimUser | null> {
  const row = await loadMembership(ctx.orgId, id);
  return row ? toScimUser(row, baseUrl) : null;
}

export interface ScimUserInput {
  userName?: unknown;
  emails?: unknown;
  active?: unknown;
  roles?: unknown;
  name?: unknown;
  displayName?: unknown;
}

function emailFrom(body: ScimUserInput): string {
  const fromUser = typeof body.userName === "string" ? body.userName.trim().toLowerCase() : "";
  if (fromUser.includes("@")) return fromUser;
  if (Array.isArray(body.emails)) {
    const objs = body.emails.filter((e): e is { value?: unknown; primary?: unknown } => Boolean(e) && typeof e === "object");
    const primary = objs.find((e) => e.primary === true) ?? objs[0];
    if (typeof primary?.value === "string" && primary.value.includes("@")) return primary.value.trim().toLowerCase();
  }
  if (fromUser) throw new ScimRequestError(400, "userName must be an email address (or supply emails[].value).", "invalidValue");
  throw new ScimRequestError(400, "userName is required.", "invalidSyntax");
}

export async function createScimUser(ctx: ScimContext, body: ScimUserInput, baseUrl: string): Promise<ScimUser> {
  const email = emailFrom(body);
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ScimRequestError(400, "userName must be a valid email address.", "invalidValue");
  const role = roleFromScim(body.roles) ?? "member";
  if (role === "owner") throw new ScimRequestError(400, "The owner role cannot be provisioned.", "invalidValue");
  const active = body.active === undefined ? true : body.active === true || String(body.active).toLowerCase() === "true";

  let membershipId: string;
  try {
    const invite = await createInvite(ctx.orgId, { email, role, invitedBy: null });
    membershipId = invite.membershipId;
    await sendInviteEmail(ctx.dataId, invite, { workspaceName: ctx.orgName }).catch((err) => console.warn("[scim] invite email not queued:", err));
  } catch (err) {
    if (err instanceof AlreadyMemberError) throw new ScimRequestError(409, `A user with userName ${email} already exists.`, "uniqueness");
    throw err;
  }
  if (!active) await query(`UPDATE memberships SET status = 'removed', invite_token_hash = NULL, updated_at = NOW() WHERE id = $1`, [membershipId]);
  const row = await queryOne<MembershipRow>(`SELECT ${COLS} FROM memberships WHERE id = $1`, [membershipId]);
  if (!row) throw new Error("membership not found after create");
  return toScimUser(row, baseUrl);
}

function toPatchable(r: MembershipRow): PatchableUser {
  return {
    userName: (r.invited_email ?? "").toLowerCase(),
    active: r.status === "active" || r.status === "invited",
    role: r.role,
  };
}

/** Persist a (PUT/PATCH) target state onto the membership row. */
async function persistUser(ctx: ScimContext, row: MembershipRow, next: PatchableUser): Promise<void> {
  const currentRole = isRole(row.role) ? row.role : "member";
  const nextRole = next.role && isRole(next.role) ? next.role : currentRole;
  if (currentRole === "owner" && (!next.active || nextRole !== "owner")) {
    throw new ScimRequestError(403, "The workspace owner cannot be deactivated or demoted through SCIM.", "mutability");
  }
  if (nextRole === "owner" && currentRole !== "owner") throw new ScimRequestError(400, "The owner role cannot be assigned through SCIM.", "invalidValue");
  if (next.userName && next.userName !== (row.invited_email ?? "").toLowerCase() && row.user_id) {
    throw new ScimRequestError(400, "userName cannot change once the user has accepted the invite.", "mutability");
  }
  const wasActive = row.status === "active" || row.status === "invited";
  const sets: string[] = ["updated_at = NOW()"];
  const params: unknown[] = [row.id];
  if (nextRole !== currentRole) {
    params.push(nextRole);
    sets.push(`role = $${params.length}`);
  }
  if (next.userName && !row.user_id && next.userName !== (row.invited_email ?? "").toLowerCase()) {
    params.push(next.userName);
    sets.push(`invited_email = $${params.length}`);
  }
  if (wasActive && !next.active) sets.push(`status = 'removed'`, `invite_token_hash = NULL`);
  if (!wasActive && next.active) sets.push(row.user_id ? `status = 'active'` : `status = 'invited'`);
  if (sets.length > 1) await query(`UPDATE memberships SET ${sets.join(", ")} WHERE id = $1`, params);
}

export async function replaceScimUser(ctx: ScimContext, id: string, body: ScimUserInput, baseUrl: string): Promise<ScimUser | null> {
  const row = await loadMembership(ctx.orgId, id);
  if (!row) return null;
  const next: PatchableUser = {
    ...toPatchable(row),
    userName: body.userName !== undefined || body.emails !== undefined ? emailFrom(body) : (row.invited_email ?? "").toLowerCase(),
    active: body.active === undefined ? true : body.active === true || String(body.active).toLowerCase() === "true",
    role: roleFromScim(body.roles) ?? row.role,
  };
  await persistUser(ctx, row, next);
  const after = await queryOne<MembershipRow>(`SELECT ${COLS} FROM memberships WHERE id = $1`, [id]);
  return after ? toScimUser(after, baseUrl) : null;
}

export async function patchScimUser(ctx: ScimContext, id: string, ops: PatchOp[], baseUrl: string): Promise<ScimUser | null> {
  const row = await loadMembership(ctx.orgId, id);
  if (!row) return null;
  let next: PatchableUser;
  try {
    next = applyUserPatch(toPatchable(row), ops);
  } catch (err) {
    throw new ScimRequestError(400, err instanceof Error ? err.message : "Invalid PATCH.", "invalidValue");
  }
  await persistUser(ctx, row, next);
  const after = await queryOne<MembershipRow>(`SELECT ${COLS} FROM memberships WHERE id = $1`, [id]);
  return after ? toScimUser(after, baseUrl) : null;
}

/** DELETE → soft remove. Returns false when the user is unknown. */
export async function deleteScimUser(ctx: ScimContext, id: string): Promise<boolean> {
  const row = await loadMembership(ctx.orgId, id);
  if (!row) return false;
  if (row.role === "owner") throw new ScimRequestError(403, "The workspace owner cannot be removed through SCIM.", "mutability");
  await query(`UPDATE memberships SET status = 'removed', invite_token_hash = NULL, updated_at = NOW() WHERE id = $1`, [row.id]);
  return true;
}

// ── Groups (= roles) ─────────────────────────────────────────────────────────

export async function listScimGroups(ctx: ScimContext, baseUrl: string): Promise<ScimGroup[]> {
  const rows = await query<Pick<MembershipRow, "id" | "role" | "invited_email">>(
    `SELECT id, role, invited_email FROM memberships WHERE org_id = $1 AND status IN ('active', 'invited') ORDER BY created_at ASC`,
    [ctx.orgId]
  );
  return ROLES.map((role) => ({
    schemas: [SCIM.GROUP],
    id: groupId(role),
    displayName: groupName(role),
    members: rows.filter((r) => r.role === role).map((r) => ({ value: r.id, display: r.invited_email ?? undefined })),
    meta: { resourceType: "Group" as const, location: `${baseUrl}/Groups/${groupId(role)}` },
  }));
}

export async function getScimGroup(ctx: ScimContext, id: string, baseUrl: string): Promise<ScimGroup | null> {
  const role = roleFromGroupId(id);
  if (!role) return null;
  const all = await listScimGroups(ctx, baseUrl);
  return all.find((g) => g.id === groupId(role)) ?? null;
}

/** Group membership changes map to role changes. `replace` resets non-listed members of this role to `member`. */
export async function patchScimGroup(
  ctx: ScimContext,
  id: string,
  change: { add: string[]; remove: string[]; replace: string[] | null },
  baseUrl: string
): Promise<ScimGroup | null> {
  const role = roleFromGroupId(id);
  if (!role) return null;
  if (role === "owner" && (change.add.length || change.remove.length || change.replace)) {
    throw new ScimRequestError(403, "Owner membership cannot be changed through SCIM.", "mutability");
  }
  const setRole = async (memberIds: string[], to: Role) => {
    for (const mid of memberIds) {
      const row = await loadMembership(ctx.orgId, mid);
      if (!row) throw new ScimRequestError(404, `Member ${mid} not found.`, "noTarget");
      if (row.role === "owner") continue; // never demote the owner
      await query(`UPDATE memberships SET role = $2, updated_at = NOW() WHERE id = $1`, [mid, to]);
    }
  };
  if (change.replace) {
    const current = await query<{ id: string }>(`SELECT id FROM memberships WHERE org_id = $1 AND role = $2 AND status IN ('active', 'invited')`, [ctx.orgId, role]);
    const keep = new Set(change.replace);
    await setRole(current.filter((r) => !keep.has(r.id)).map((r) => r.id), "member");
    await setRole(change.replace, role);
  }
  await setRole(change.add, role);
  // Removing from a role group drops the member to the default role (never deactivates).
  await setRole(change.remove, "member");
  return getScimGroup(ctx, id, baseUrl);
}
