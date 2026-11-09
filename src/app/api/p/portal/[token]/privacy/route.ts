import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { queryOne } from "@/lib/dsql";
import { rateLimit } from "@/lib/request-limits";
import { resolveShareToken } from "@/lib/share-tokens";
import { currentConsent, recordConsent } from "@/lib/privacy/consent";
import { CONSENT_PURPOSE_LABELS, DSR_KINDS, SELF_SERVICE_PURPOSES } from "@/lib/privacy/constants";
import { buildSubjectExport, DsrError, listRequests, openRequest } from "@/lib/privacy/dsr";
import { latestPublished } from "@/lib/privacy/notices";
import { getPrivacySettings } from "@/lib/privacy/settings";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ token: string }> };

const ip = (req: NextRequest) => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "anon";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("consent"), purpose: z.enum(SELF_SERVICE_PURPOSES as [string, ...string[]]), granted: z.boolean() }).strict(),
  z.object({ action: z.literal("request"), kind: z.enum(DSR_KINDS), notes: z.string().trim().max(2000).optional() }).strict(),
]);

async function auth(ctx: Ctx) {
  const { token } = await ctx.params;
  const t = await resolveShareToken("portal", token);
  if (!t) return null;
  const contact = await queryOne<{ id: string }>(`SELECT id FROM crm_contacts WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL`, [t.user_id, t.entity_id]).catch(() => null);
  return contact ? { dataId: t.user_id, contactId: t.entity_id } : null;
}

/** GET → consents (self-service purposes), open requests, notice path, grievance contact. */
export async function GET(req: NextRequest, ctx: Ctx) {
  if (!rateLimit(`portal-privacy:${ip(req)}`, 60, 60_000).allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  try {
    const a = await auth(ctx);
    if (!a) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const subject = { kind: "contact" as const, id: a.contactId };
    const [current, requests, settings, notice, org] = await Promise.all([
      currentConsent(a.dataId, subject),
      listRequests(a.dataId, { subject, limit: 50 }),
      getPrivacySettings(a.dataId),
      latestPublished(a.dataId),
      queryOne<{ slug: string }>(`SELECT slug FROM organizations WHERE owner_user_id = $1`, [a.dataId]).catch(() => null),
    ]);
    return NextResponse.json({
      consents: SELF_SERVICE_PURPOSES.map((p) => ({ purpose: p, label: CONSENT_PURPOSE_LABELS[p], granted: current[p]?.status === "granted", at: current[p]?.at ?? null })),
      requests: requests.map((r) => ({ id: r.id, kind: r.kind, status: r.status, requested_at: r.requested_at, due_at: r.due_at, completed_at: r.completed_at })),
      notice_path: notice && org?.slug ? `/p/privacy/${org.slug}` : null,
      grievance: { name: settings.grievance_officer_name, email: settings.grievance_officer_email, response_days: settings.dsr_due_days },
      auto_fulfil_access: settings.auto_fulfil_access,
    });
  } catch (err) {
    console.error("[portal privacy] GET failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * POST {action:"consent", purpose, granted} → append ledger row.
 * POST {action:"request", kind} → opens a pre-verified request (the portal token authenticates the
 * contact). Access requests return the export inline when the org enabled auto_fulfil_access.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  if (!rateLimit(`portal-privacy:${ip(req)}`, 30, 60_000).allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  try {
    const a = await auth(ctx);
    if (!a) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
    const subject = { kind: "contact" as const, id: a.contactId };
    const evidence = { ip: ip(req), ua: req.headers.get("user-agent"), notice_version: (await latestPublished(a.dataId))?.version ?? null };
    const b = parsed.data;
    if (b.action === "consent") {
      const row = await recordConsent(a.dataId, subject, b.purpose as (typeof SELF_SERVICE_PURPOSES)[number], b.granted ? "granted" : "withdrawn", "portal", evidence);
      return NextResponse.json({ ok: true, consent: { purpose: row.purpose, status: row.status, at: row.occurred_at } });
    }
    const open = await listRequests(a.dataId, { subject, status: "open" });
    if (open.some((r) => r.kind === b.kind)) return NextResponse.json({ error: "You already have an open request of this kind." }, { status: 409 });
    const request = await openRequest(a.dataId, { subject, kind: b.kind, source: "portal", preVerified: true, notes: b.notes ?? null });
    let bundle: Record<string, unknown> | null = null;
    if ((b.kind === "access" || b.kind === "portability") && (await getPrivacySettings(a.dataId)).auto_fulfil_access) {
      bundle = (await buildSubjectExport(a.dataId, subject)) as unknown as Record<string, unknown>;
      await queryOne(`UPDATE dsr_requests SET status = 'completed', completed_at = NOW(), result = $3 WHERE id = $1 AND user_id = $2 RETURNING id`, [request.id, a.dataId, JSON.stringify({ auto_fulfilled: true })]).catch(() => null);
    }
    return NextResponse.json(
      { ok: true, request: { id: request.id, kind: request.kind, status: bundle ? "completed" : request.status, due_at: request.due_at }, export: bundle },
      { status: 201 }
    );
  } catch (err) {
    if (err instanceof DsrError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error("[portal privacy] POST failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
