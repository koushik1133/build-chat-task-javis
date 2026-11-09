import { NextResponse, type NextRequest } from "next/server";
import { parseBody, paramId } from "@/lib/money/http";
import { recordAudit } from "@/lib/audit";
import { enroll } from "@/lib/marketing/sequences";
import { marketingError, marketingScope } from "@/lib/marketing/http";
import { EnrollSchema } from "@/lib/marketing/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST { contact_ids } — enroll contacts (idempotent per contact).
 *
 * Enroll picker: search contacts with `GET /api/crm/contacts?q=<text>&limit=<n>` (requires the
 * crm view area). `q` matches full_name, email and company (case-insensitive substring); results
 * are keyset-paginated via `next_cursor`. Pass the chosen `id`s here.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = await marketingScope(true);
  if (!s.ok) return s.res;
  const body = await parseBody(req, EnrollSchema, 64_000);
  if (!body.ok) return body.res;
  try {
    const id = await paramId(ctx);
    let created = 0;
    let existing = 0;
    const errors: Array<{ contact_id: string; reason: string }> = [];
    for (const contactId of body.data.contact_ids) {
      const r = await enroll(s.scope.dataId, id, contactId, "manual");
      if (!r.ok) {
        if (r.reason === "sequence_not_found") return NextResponse.json({ error: "not_found" }, { status: 404 });
        if (r.reason === "sequence_paused") return NextResponse.json({ error: "sequence_paused", detail: "Resume the sequence before enrolling contacts." }, { status: 409 });
        errors.push({ contact_id: contactId, reason: r.reason });
      } else if (r.created) created++;
      else existing++;
    }
    await recordAudit(s.scope, { action: "marketing.sequence.enrolled", entity: "sequence", entityId: id, after: { summary: `${created} enrolled, ${existing} already present` } });
    return NextResponse.json({ created, existing, errors });
  } catch (err) {
    return marketingError(err, "marketing/sequences.enroll");
  }
}
