import { ROUTES } from "@/lib/public-api/registry";
import { libCall, op, singlePage } from "@/lib/public-api/handler";
import { issueGiftCard, listGiftCards } from "@/lib/engagement/giftcards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listGiftCards, async ({ principal, query }) => singlePage(await listGiftCards(principal.dataId, { limit: query.limit })));
export const POST = op(ROUTES.issueGiftCard, async ({ principal, body }) => {
  const { card, code } = await libCall(() => issueGiftCard(principal.dataId, { amountMinor: body.amount_minor, currency: body.currency, recipientEmail: body.recipient_email, message: body.message, expiresAt: body.expires_at, issuedVia: "manual" }));
  return { data: { gift_card: card, code }, status: 201 };
});
