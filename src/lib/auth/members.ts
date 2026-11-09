import { queryOne } from "@/lib/dsql";

/**
 * Is `userId` allowed to be referenced as a member/assignee of the workspace
 * whose data lives under `dataId`? True for the org owner (the data id itself)
 * and for any active membership of that org. Ids from other orgs, invited-only
 * memberships and random strings are refused, so cross-tenant user ids can
 * never be written into assignee/member columns.
 */
export async function isWorkspaceMember(dataId: string, userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  if (userId === dataId) return true;
  const m = await queryOne<{ id: string }>(
    `SELECT m.id FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE o.owner_user_id = $1 AND m.user_id = $2 AND m.status = 'active' LIMIT 1`,
    [dataId, userId]
  ).catch(() => null);
  return Boolean(m);
}
