import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import type { Role } from "@/lib/auth/roles";
import type { Scope } from "@/lib/auth/scope";
import { createInvite, sendInviteEmail, type CreatedInvite } from "@/lib/team";

/**
 * Agency mode: a parent ("agency") organization owns child ("client")
 * workspaces and can switch into them or report across them.
 *
 * HOW CHILD ORGS ARE KEYED — read this before touching anything here.
 *
 * Every module table is keyed by `user_id = organizations.owner_user_id`
 * (see src/lib/auth/scope.ts). A real user can own exactly one org (unique
 * index on owner_user_id), so a child workspace cannot reuse the agency
 * owner's id — its data would collide with the agency's own data. Instead a
 * child org's `owner_user_id` is a NEW synthetic data id: the child org's own
 * `id`. Nothing in Supabase auth has that id; it exists only as a data key.
 *
 * Access works through memberships: the parent org's owner (and, on creation,
 * the acting user) gets an `owner` membership on the child, so
 * `requireScope()` resolves the child via the membership join and returns
 * `dataId = child.id`. `ensurePersonalOrg()` only ever looks up
 * `owner_user_id = <auth user id>`, which never matches a synthetic id, so
 * it is never confused by client workspaces.
 */

export type OrgKind = "standard" | "agency" | "client";

export interface ChildOrgRow {
  id: string;
  name: string;
  slug: string;
  owner_user_id: string;
  parent_org_id: string | null;
  kind: string | null;
  archived_at: string | null;
  created_at: string;
}

export interface ChildOrgDTO {
  id: string;
  name: string;
  slug: string;
  /** Data key for every table of this workspace (= the child org id). */
  dataId: string;
  parentOrgId: string | null;
  kind: OrgKind;
  archived: boolean;
  archivedAt: string | null;
  createdAt: string;
  members: number;
  pendingInvites: number;
}

const COLS = "id, name, slug, owner_user_id, parent_org_id, kind, archived_at, created_at";

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || "client";
}

function toDTO(r: ChildOrgRow, counts?: { members: number; invites: number }): ChildOrgDTO {
  const kind: OrgKind = r.kind === "agency" || r.kind === "client" ? r.kind : "standard";
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    dataId: r.owner_user_id,
    parentOrgId: r.parent_org_id,
    kind,
    archived: Boolean(r.archived_at),
    archivedAt: r.archived_at,
    createdAt: r.created_at,
    members: counts?.members ?? 0,
    pendingInvites: counts?.invites ?? 0,
  };
}

/** The org row whose data key is `dataId` (organizations.owner_user_id is unique). */
export async function orgByDataId(dataId: string): Promise<ChildOrgRow | null> {
  return queryOne<ChildOrgRow>(`SELECT ${COLS} FROM organizations WHERE owner_user_id = $1`, [dataId]);
}

/** Flip the active org to `agency` kind (idempotent; standard → agency only). */
export async function markAsAgency(parentOrgId: string): Promise<void> {
  await query(`UPDATE organizations SET kind = 'agency', updated_at = NOW() WHERE id = $1 AND COALESCE(kind, 'standard') = 'standard'`, [parentOrgId]);
}

/**
 * Create a client workspace under the caller's active org. The caller must be
 * the owner/admin of the parent (checked by the route via requireScope).
 */
export class AgencyForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgencyForbiddenError";
  }
}

export interface SnapshotOutcome {
  snapshot_id: string;
  status: "applied" | "partial" | "failed";
  created: number;
  updated: number;
  skipped: number;
  errors: Array<{ section: string; key: string; message: string }>;
}

/**
 * Apply an agency-visible snapshot of the PARENT org to a freshly created
 * client workspace. Never throws: a failure is reported in the outcome so org
 * creation still succeeds.
 */
async function applyStartingSnapshot(parent: Pick<Scope, "userId" | "dataId">, childDataId: string, snapshotId: string): Promise<SnapshotOutcome> {
  const fail = (message: string): SnapshotOutcome => ({ snapshot_id: snapshotId, status: "failed", created: 0, updated: 0, skipped: 0, errors: [{ section: "snapshot", key: snapshotId, message }] });
  try {
    const { getSnapshotDoc, applySnapshot } = await import("@/lib/snapshots/store");
    const found = await getSnapshotDoc(parent.dataId, snapshotId);
    if (!found || found.meta.origin !== "own" || found.meta.visibility !== "agency") return fail("Snapshot not found or not shared with client workspaces");
    const r = await applySnapshot(childDataId, found.doc, { mode: "skip_existing", actorId: parent.userId, snapshotId, snapshotSha: found.meta.sha256 });
    return { snapshot_id: snapshotId, status: r.status, created: r.created, updated: r.updated, skipped: r.skipped, errors: r.errors };
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Snapshot apply failed");
  }
}

export async function createChildOrg(
  parent: Pick<Scope, "orgId" | "userId" | "dataId" | "role">,
  input: { name: string; slug?: string | null; snapshot_id?: string | null }
): Promise<ChildOrgDTO & { snapshot_result?: SnapshotOutcome }> {
  // Only the parent's owner or an admin may create client workspaces, whatever
  // area overrides say about "settings" — this hands out memberships on a new org.
  if (parent.role !== "owner" && parent.role !== "admin") {
    throw new AgencyForbiddenError("Only the workspace owner or an admin can create client workspaces.");
  }
  const name = input.name.trim();
  if (!name) throw new Error("name is required");
  const id = randomUUID();
  const base = slugify(input.slug?.trim() || name);
  let slug = `${base}-${id.slice(0, 6)}`;
  if (input.slug?.trim()) {
    const taken = await queryOne<{ id: string }>(`SELECT id FROM organizations WHERE slug = $1`, [base]);
    slug = taken ? slug : base;
  }

  // owner_user_id = id: the synthetic data key explained at the top of this file.
  await query(
    `INSERT INTO organizations (id, name, slug, owner_user_id, settings, parent_org_id, kind)
     VALUES ($1, $2, $3, $1, NULL, $4, 'client')`,
    [id, name, slug, parent.orgId]
  );

  // Memberships so requireScope() can switch into the child: the parent org's
  // real owner becomes the child's owner; an acting admin gets an admin seat
  // (never a self-granted owner role).
  const parentOwner = await queryOne<{ owner_user_id: string }>(`SELECT owner_user_id FROM organizations WHERE id = $1`, [parent.orgId]);
  const seats = new Map<string, Role>();
  if (parentOwner?.owner_user_id) seats.set(parentOwner.owner_user_id, "owner");
  if (!seats.has(parent.userId)) seats.set(parent.userId, parent.role === "owner" ? "owner" : "admin");
  for (const [uid, role] of seats) {
    await query(
      `INSERT INTO memberships (id, org_id, user_id, role, status, accepted_at) VALUES ($1, $2, $3, $4, 'active', NOW())`,
      [randomUUID(), id, uid, role]
    );
  }
  await markAsAgency(parent.orgId);

  const row = await queryOne<ChildOrgRow>(`SELECT ${COLS} FROM organizations WHERE id = $1`, [id]);
  if (!row) throw new Error("client workspace creation failed");
  const dto = toDTO(row, { members: seats.size, invites: 0 });
  if (input.snapshot_id) {
    // The child's data key is its own org id (see the header comment).
    return { ...dto, snapshot_result: await applyStartingSnapshot(parent, row.owner_user_id, input.snapshot_id) };
  }
  return dto;
}

async function membershipCounts(orgIds: string[]): Promise<Map<string, { members: number; invites: number }>> {
  const out = new Map<string, { members: number; invites: number }>();
  if (orgIds.length === 0) return out;
  const rows = await query<{ org_id: string; status: string; n: string | number }>(
    `SELECT org_id, status, COUNT(*) AS n FROM memberships WHERE org_id = ANY($1::text[]) AND status IN ('active', 'invited') GROUP BY org_id, status`,
    [orgIds]
  ).catch(() => []);
  for (const r of rows) {
    const c = out.get(r.org_id) ?? { members: 0, invites: 0 };
    if (r.status === "active") c.members = Number(r.n);
    else c.invites = Number(r.n);
    out.set(r.org_id, c);
  }
  return out;
}

/** Child workspaces of the org whose data key is `parentDataId`. */
export async function listChildOrgs(parentDataId: string, opts: { includeArchived?: boolean } = {}): Promise<ChildOrgDTO[]> {
  const parent = await orgByDataId(parentDataId);
  if (!parent) return [];
  const rows = await query<ChildOrgRow>(
    `SELECT ${COLS} FROM organizations WHERE parent_org_id = $1 ${opts.includeArchived ? "" : "AND archived_at IS NULL"} ORDER BY name ASC`,
    [parent.id]
  );
  const counts = await membershipCounts(rows.map((r) => r.id));
  return rows.map((r) => toDTO(r, counts.get(r.id)));
}

/** One child, only when it belongs to the parent. */
export async function getChildOrg(parentDataId: string, childId: string): Promise<ChildOrgDTO | null> {
  const parent = await orgByDataId(parentDataId);
  if (!parent) return null;
  const row = await queryOne<ChildOrgRow>(`SELECT ${COLS} FROM organizations WHERE id = $1 AND parent_org_id = $2`, [childId, parent.id]);
  if (!row) return null;
  const counts = await membershipCounts([row.id]);
  return toDTO(row, counts.get(row.id));
}

export async function updateChildOrg(
  parentDataId: string,
  childId: string,
  patch: { name?: string; archived?: boolean }
): Promise<ChildOrgDTO | null> {
  const current = await getChildOrg(parentDataId, childId);
  if (!current) return null;
  const sets: string[] = ["updated_at = NOW()"];
  const params: unknown[] = [childId];
  if (patch.name !== undefined) {
    params.push(patch.name.trim());
    sets.push(`name = $${params.length}`);
  }
  if (patch.archived !== undefined) sets.push(patch.archived ? "archived_at = COALESCE(archived_at, NOW())" : "archived_at = NULL");
  await query(`UPDATE organizations SET ${sets.join(", ")} WHERE id = $1`, params);
  if (patch.archived === true) {
    // Suspending memberships is what removes the workspace from requireScope()
    // and the switcher (both only join status = 'active'); unarchive restores them.
    await query(`UPDATE memberships SET status = 'suspended', updated_at = NOW() WHERE org_id = $1 AND status = 'active'`, [childId]);
  } else if (patch.archived === false) {
    await query(`UPDATE memberships SET status = 'active', updated_at = NOW() WHERE org_id = $1 AND status = 'suspended'`, [childId]);
  }
  return getChildOrg(parentDataId, childId);
}

/** Archive (soft delete). The workspace and its data stay; it drops out of lists and the switcher. */
export async function archiveChildOrg(parentDataId: string, childId: string): Promise<boolean> {
  const r = await updateChildOrg(parentDataId, childId, { archived: true });
  return Boolean(r);
}

/** Invite a client-side user into a child workspace, reusing the team invite flow. */
export async function inviteClientUser(
  childOrgId: string,
  email: string,
  role: Exclude<Role, "owner">,
  opts: { invitedBy: string | null; origin?: string | null; message?: string | null }
): Promise<CreatedInvite> {
  const child = await queryOne<{ id: string; name: string; owner_user_id: string }>(
    `SELECT id, name, owner_user_id FROM organizations WHERE id = $1 AND kind = 'client' AND archived_at IS NULL`,
    [childOrgId]
  );
  if (!child) throw new Error("Client workspace not found");
  const invite = await createInvite(child.id, { email, role, invitedBy: opts.invitedBy, origin: opts.origin });
  await sendInviteEmail(child.owner_user_id, invite, { workspaceName: child.name, message: opts.message }).catch((err) => {
    console.warn("[agency] invite email not queued:", err);
  });
  return invite;
}
