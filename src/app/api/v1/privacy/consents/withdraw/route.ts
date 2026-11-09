import { withdraw } from "@/lib/privacy/consent";
import { ROUTES } from "@/lib/public-api/registry";
import { op, libCall } from "@/lib/public-api/handler";
import { consentView } from "@/lib/public-api/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = op(ROUTES.withdrawConsent, async ({ principal, body }) => ({
  data: consentView(
    await libCall(() =>
      withdraw(principal.dataId, { kind: body.subject_kind, id: body.subject_id }, body.purpose, "api", { text_version: body.text_version ?? null, text: body.text ?? null, actor: `api_key:${principal.keyId}` })
    )
  ),
  status: 201,
}));
