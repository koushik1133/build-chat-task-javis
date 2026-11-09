import { clientIp as sharedClientIp } from "@/lib/request-limits";
import type { NextRequest } from "next/server";
import { queryOne } from "@/lib/dsql";
import { resolveShareToken } from "@/lib/share-tokens";

export interface PortalAuth {
  dataId: string;
  contactId: string;
}

/** Trusted-hop aware caller IP (the leftmost X-Forwarded-For entry is client-controlled). */
export function clientIp(req: NextRequest): string {
  return sharedClientIp(req);
}

/** Resolve a portal token to its org + contact; null when invalid/expired/revoked or the contact is gone. */
export async function authPortalToken(token: string): Promise<PortalAuth | null> {
  const t = await resolveShareToken("portal", token);
  if (!t) return null;
  const contact = await queryOne<{ id: string }>(`SELECT id FROM crm_contacts WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL`, [t.user_id, t.entity_id]).catch(() => null);
  return contact ? { dataId: t.user_id, contactId: t.entity_id } : null;
}
