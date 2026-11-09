import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { query } from "@/lib/dsql";
import { escapeLike } from "@/lib/like";
import { CONSENT_PURPOSES, CONSENT_SUBJECT_KINDS } from "@/lib/privacy/constants";
import { currentConsent, listRecent, recordConsent } from "@/lib/privacy/consent";
import { privacyError, privacyScope } from "../_lib";

export const runtime = "nodejs";

const CreateSchema = z
  .object({
    subject_kind: z.enum(CONSENT_SUBJECT_KINDS.filter((k) => k !== "tombstone") as [string, ...string[]]),
    subject_id: z.string().min(1).max(80),
    purpose: z.enum(CONSENT_PURPOSES),
    status: z.enum(["granted", "withdrawn"]),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

/**
 * GET ?q=<contact search> → matching contacts with current consent per purpose.
 * GET ?subject_kind=&subject_id= → that subject's current state + history.
 * GET (no params) → recent ledger rows.
 */
export async function GET(req: NextRequest) {
  const s = await privacyScope(false);
  if ("res" in s) return s.res;
  try {
    const sp = new URL(req.url).searchParams;
    const q = sp.get("q")?.trim();
    if (q) {
      const contacts = await query<{ id: string; full_name: string; email: string | null; phone: string | null }>(
        `SELECT id, full_name, email, phone FROM crm_contacts WHERE user_id = $1 AND deleted_at IS NULL AND (full_name ILIKE $2 OR email ILIKE $2 OR phone ILIKE $2) ORDER BY updated_at DESC LIMIT 25`,
        [s.scope.dataId, `%${escapeLike(q)}%`]
      );
      const results = await Promise.all(contacts.map(async (c) => ({ ...c, consent: await currentConsent(s.scope.dataId, { kind: "contact", id: c.id }) })));
      return NextResponse.json({ contacts: results });
    }
    const kind = sp.get("subject_kind");
    const id = sp.get("subject_id");
    if (kind && id && (CONSENT_SUBJECT_KINDS as readonly string[]).includes(kind)) {
      const subject = { kind: kind as (typeof CONSENT_SUBJECT_KINDS)[number], id };
      const [current, history] = await Promise.all([currentConsent(s.scope.dataId, subject), listRecent(s.scope.dataId, { subjectIds: [id], limit: 100 })]);
      return NextResponse.json({ current, history });
    }
    return NextResponse.json({ history: await listRecent(s.scope.dataId, { limit: 100 }) });
  } catch (err) {
    return privacyError(err, "list consents");
  }
}

/** POST — manual grant / withdraw by staff (evidence records the actor). */
export async function POST(req: NextRequest) {
  const s = await privacyScope(true);
  if ("res" in s) return s.res;
  const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  try {
    const d = parsed.data;
    const row = await recordConsent(s.scope.dataId, { kind: d.subject_kind as "contact" | "lead" | "member", id: d.subject_id }, d.purpose, d.status, "manual", {
      actor: s.scope.userId,
      text: d.note ?? null,
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      ua: req.headers.get("user-agent"),
    });
    return NextResponse.json({ consent: row }, { status: 201 });
  } catch (err) {
    return privacyError(err, "record consent");
  }
}
