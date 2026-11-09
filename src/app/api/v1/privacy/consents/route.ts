import { currentConsent, listForSubject, recordConsent } from "@/lib/privacy/consent";
import { ROUTES } from "@/lib/public-api/registry";
import { op, libCall } from "@/lib/public-api/handler";
import { consentView } from "@/lib/public-api/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listConsents, async ({ principal, query }) => {
  const subject = { kind: query.subject_kind, id: query.subject_id };
  const [current, history] = await Promise.all([currentConsent(principal.dataId, subject), listForSubject(principal.dataId, subject, query.limit ?? 200)]);
  return { data: { subject_kind: subject.kind, subject_id: subject.id, current, history: history.map(consentView) } };
});

export const POST = op(ROUTES.recordConsent, async ({ principal, body }) => ({
  data: consentView(
    await libCall(() =>
      recordConsent(principal.dataId, { kind: body.subject_kind, id: body.subject_id }, body.purpose, "granted", "api", {
        text_version: body.text_version ?? null,
        text: body.text ?? null,
        actor: `api_key:${principal.keyId}`,
      })
    )
  ),
  status: 201,
}));
