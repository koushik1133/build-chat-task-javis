import { samplePayload } from "@/lib/webhooks/dispatch";
import { ROUTES } from "@/lib/public-api/registry";
import { op } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sample payload for Zapier/Make "perform list" so fields can be mapped before a real event fires. */
export const GET = op(ROUTES.sampleWebhook, async ({ params }) => ({ data: samplePayload(params.event) }));
