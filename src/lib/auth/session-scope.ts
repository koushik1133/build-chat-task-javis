import { cookies } from "next/headers";
import { queryOne } from "@/lib/dsql";
import { ORG_COOKIE } from "@/lib/auth/scope";

/**
 * Cheap org resolution for Server Components that already hold a session.
 *
 * Reads the active-workspace cookie and, when it points at an org the user is
 * an active member of, returns that org's owner id (the key its data lives
 * under). Falls back to the user's own id, which is the personal workspace.
 * Unlike `requireScope()` this makes no auth network call and never inserts.
 */
export async function resolveDataId(userId: string): Promise<string> {
  let wanted: string | null = null;
  try {
    wanted = (await cookies()).get(ORG_COOKIE)?.value ?? null;
  } catch {
    wanted = null;
  }
  if (!wanted) return userId;

  const row = await queryOne<{ owner_user_id: string }>(
    `SELECT o.owner_user_id
       FROM memberships m JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = $1 AND m.org_id = $2 AND m.status = 'active'`,
    [userId, wanted]
  ).catch(() => null);
  return row?.owner_user_id ?? userId;
}
