import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { applyPaymentEvent } from "@/lib/money/invoices";
import { getProvider, isProviderId } from "./index";

/**
 * One verified path for every provider event, used by the public webhook
 * route and by the simulated checkout page. Fail closed: anything that is not
 * a verified, well-formed, first-seen event is rejected or ignored.
 */

export type WebhookOutcome =
  | { status: 401; body: { error: string } }
  | { status: 404; body: { error: string } }
  | { status: 200; body: { ok: true; replay?: boolean; ignored?: boolean; invoiceId?: string; invoiceStatus?: string | null } }
  | { status: 500; body: { error: string } };

export async function processWebhook(providerId: string, rawBody: string, headers: Headers): Promise<WebhookOutcome> {
  if (!isProviderId(providerId)) return { status: 404, body: { error: "unknown_provider" } };
  const provider = getProvider(providerId);
  const v = await provider.verifyWebhook(rawBody, headers);
  if (!v.ok) return { status: 401, body: { error: v.error ?? "verification_failed" } };
  if (!v.event) return { status: 200, body: { ok: true, ignored: true } };
  const evt = v.event;
  if (!evt.eventId) return { status: 401, body: { error: "missing_event_id" } };

  // Idempotency: first writer wins, replays are a no-op 200.
  const seen = await queryOne(`SELECT id FROM payment_events WHERE provider = $1 AND provider_event_id = $2`, [providerId, evt.eventId]);
  if (seen) return { status: 200, body: { ok: true, replay: true } };
  const rowId = randomUUID();
  try {
    await query(
      `INSERT INTO payment_events (id, provider, provider_event_id, payload) VALUES ($1, $2, $3, $4)`,
      [rowId, providerId, evt.eventId, rawBody.slice(0, 200_000)]
    );
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
    if (code === "23505") return { status: 200, body: { ok: true, replay: true } };
    throw err;
  }

  try {
    const applied = await applyPaymentEvent(providerId, evt);
    if (!applied) {
      console.warn(`[payments] ${providerId} event ${evt.eventId} did not map to an invoice`);
      return { status: 200, body: { ok: true, ignored: true } };
    }
    return { status: 200, body: { ok: true, invoiceId: applied.invoiceId, invoiceStatus: applied.status } };
  } catch (err) {
    // Release the idempotency slot so the provider's retry can succeed.
    await query(`DELETE FROM payment_events WHERE id = $1`, [rowId]).catch(() => undefined);
    console.error(`[payments] apply failed for ${providerId}:${evt.eventId}`, err);
    return { status: 500, body: { error: "apply_failed" } };
  }
}
