import { sendForSignature } from "@/lib/documents/signing";
import { ROUTES } from "@/lib/public-api/registry";
import { op } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = op(ROUTES.sendDocument, async ({ principal, params, body }) => {
  const out = await sendForSignature(principal.dataId, params.id, { message: body.message ?? null, expires_in_days: body.expires_in_days ?? null }, null);
  return { data: { ...out.document, notified: out.notified } };
});
