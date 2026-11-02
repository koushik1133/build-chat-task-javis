/**
 * POST /api/agency/switch {orgId} — set the active workspace cookie (kh_org).
 *
 * Same contract and checks as /api/orgs/switch: the caller must hold an active
 * membership on the target org, which is exactly how the agency owner (owner
 * membership on each client workspace) and invited client users get in.
 * Kept under /api/agency so the clients page has one base path.
 */
export { POST } from "@/app/api/orgs/switch/route";

export const dynamic = "force-dynamic";
