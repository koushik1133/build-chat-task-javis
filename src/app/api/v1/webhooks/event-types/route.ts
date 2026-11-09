import { EVENT_TYPES } from "@/lib/events/bus";
import { samplePayload } from "@/lib/webhooks/dispatch";
import { ROUTES } from "@/lib/public-api/registry";
import { op } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public catalogue of event types with a representative payload each (no auth). */
export const GET = op(ROUTES.listWebhookEventTypes, async () => ({
  data: EVENT_TYPES.map((type) => {
    const sample = samplePayload(type);
    return { type, entity: sample.entity, sample };
  }),
  headers: { "Cache-Control": "public, max-age=300" },
}));
