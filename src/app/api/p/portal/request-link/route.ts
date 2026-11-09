import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { queryOne } from "@/lib/dsql";
import { rateLimitAsync } from "@/lib/request-limits";
import { clientIp } from "@/lib/portal-auth";
import { resolveOrgBySlug } from "@/lib/calendar/booking";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { appOrigin, issueShareToken } from "@/lib/share-tokens";

export const runtime = "nodejs";

const Body = z.object({ org: z.string().trim().min(1).max(100), email: z.string().trim().toLowerCase().email().max(320) }).strict();

const GENERIC = { ok: true, message: "If we have a record for that email, a portal link is on its way." };
/** Every response takes at least this long, so a hit (lookup + enqueue) is indistinguishable from a miss. */
const MIN_MS = 350;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sendLink(orgSlug: string, email: string): Promise<void> {
  const org = await resolveOrgBySlug(orgSlug);
  if (!org) return;
  const contact = await queryOne<{ id: string; full_name: string }>(
    `SELECT id, full_name FROM crm_contacts WHERE user_id = $1 AND lower(email) = $2 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [org.dataId, email]
  ).catch(() => null);
  if (!contact) return;
  // Per-address cap regardless of caller IP: a victim's inbox cannot be flooded.
  if (!(await rateLimitAsync(`portal-link-addr:${org.dataId}:${email}`, 3, 3_600_000)).allowed) return;
  const link = await issueShareToken(org.dataId, "portal", contact.id, 7);
  await enqueueNotification(org.dataId, {
    channel: "email",
    recipient: email,
    subject: `Your ${org.name} portal link`,
    body: `Hi ${contact.full_name},\n\nHere is your private link to view your appointments, invoices and messages:\n${appOrigin()}/p/c/${link.token}\n\nIt expires in 7 days. If you did not ask for this, you can ignore this email.`,
    data: { kind: "portal.link", category: "customers", transactional: true, contactId: contact.id },
  });
}

/** POST /api/p/portal/request-link { org, email } — always 202 with the same body (no enumeration). */
export async function POST(req: NextRequest) {
  const started = Date.now();
  const finish = async (status: number, body: Record<string, unknown>) => {
    const wait = MIN_MS - (Date.now() - started);
    if (wait > 0) await sleep(wait);
    return NextResponse.json(body, { status });
  };
  try {
    const ip = clientIp(req);
    if (!(await rateLimitAsync(`portal-link:${ip}`, 10, 600_000)).allowed) return finish(429, { error: "rate_limited" });
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return finish(202, GENERIC); // malformed input is indistinguishable too
    if (!(await rateLimitAsync(`portal-link-ip-email:${ip}:${parsed.data.email}`, 3, 600_000)).allowed) return finish(202, GENERIC);
    await sendLink(parsed.data.org, parsed.data.email).catch((err) => console.error("[portal] request-link failed:", err instanceof Error ? err.message : err));
    return finish(202, GENERIC);
  } catch (err) {
    console.error("[portal] request-link error:", err);
    return finish(202, GENERIC);
  }
}
