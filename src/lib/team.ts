import { createHash, randomBytes, randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import type { Role } from "@/lib/auth/roles";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { appOrigin } from "@/lib/share-tokens";

/**
 * Team invites, shared by /api/team/invite, agency client invites and SCIM
 * provisioning. A pending membership row holds the SHA-256 of a one-time
 * token; /invite/<token> redeems it (see /api/team/accept).
 */

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface CreatedInvite {
  membershipId: string;
  email: string;
  role: Role;
  /** Plaintext token — shown/sent once, never stored. */
  token: string;
  inviteUrl: string;
  /** True when an existing pending invite was re-issued rather than created. */
  reissued: boolean;
}

export class AlreadyMemberError extends Error {
  constructor(public readonly membershipId: string) {
    super("already a member");
    this.name = "AlreadyMemberError";
  }
}

export function invitePath(token: string): string {
  return `/invite/${token}`;
}

/**
 * Create (or re-issue) a pending membership for `email` on `orgId`.
 * Throws AlreadyMemberError when the address already has an active membership.
 */
export async function createInvite(
  orgId: string,
  input: { email: string; role: Role; invitedBy: string | null; origin?: string | null }
): Promise<CreatedInvite> {
  const email = input.email.trim().toLowerCase();
  const existing = await queryOne<{ id: string; status: string }>(
    `SELECT id, status FROM memberships
      WHERE org_id = $1 AND LOWER(invited_email) = $2 AND status IN ('active', 'invited')
      LIMIT 1`,
    [orgId, email]
  );
  if (existing?.status === "active") throw new AlreadyMemberError(existing.id);

  const token = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  let membershipId: string;
  let reissued = false;

  if (existing?.status === "invited") {
    // Re-issue: replace the old token and refresh the expiry window.
    membershipId = existing.id;
    reissued = true;
    await query(
      `UPDATE memberships SET role = $1, invite_token_hash = $2, invited_by = $3, created_at = NOW(), updated_at = NOW()
        WHERE id = $4`,
      [input.role, tokenHash, input.invitedBy, membershipId]
    );
  } else {
    membershipId = randomUUID();
    await query(
      `INSERT INTO memberships (id, org_id, user_id, role, status, invited_email, invite_token_hash, invited_by)
       VALUES ($1, $2, NULL, $3, 'invited', $4, $5, $6)`,
      [membershipId, orgId, input.role, email, tokenHash, input.invitedBy]
    );
  }

  const origin = (input.origin ?? appOrigin()).replace(/\/$/, "");
  return { membershipId, email, role: input.role, token, inviteUrl: `${origin}${invitePath(token)}`, reissued };
}

/** Queue the invite email through the outbox (simulated when email is not live). */
export async function sendInviteEmail(
  dataId: string,
  invite: Pick<CreatedInvite, "email" | "role" | "inviteUrl" | "membershipId">,
  opts: { workspaceName: string; message?: string | null }
): Promise<string> {
  return enqueueNotification(dataId, {
    channel: "email",
    recipient: invite.email,
    subject: `You're invited to ${opts.workspaceName}`,
    body:
      `${opts.message?.trim() ? opts.message.trim() + "\n\n" : ""}` +
      `You've been invited to join ${opts.workspaceName} as ${invite.role}.\n\n` +
      `Accept the invite here: ${invite.inviteUrl}\n\n` +
      `The link expires in 7 days and can only be used once.`,
    data: { kind: "team_invite", membership_id: invite.membershipId, role: invite.role, url: invite.inviteUrl },
  });
}
