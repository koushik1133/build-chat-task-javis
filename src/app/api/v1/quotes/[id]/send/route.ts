import { sendQuote } from "@/lib/money/quotes";
import { ROUTES } from "@/lib/public-api/registry";
import { op } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = op(ROUTES.sendQuote, async ({ principal, params, body }) => {
  const { quote, url, path } = await sendQuote(principal.dataId, params.id, { to: body.to ?? null, message: body.message ?? null });
  return { data: { ...quote, share: { url, path } } };
});
