import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { AUTO_DISABLE_AFTER, afterFailure, DELIVERY_TIMEOUT_MS, isSuccessStatus, shouldAutoDisable, type DeliveryStatus } from "./backoff";
import { DELIVERY_HEADER, EVENT_HEADER, SIGNATURE_HEADER, signPayload } from "./sign";
import { getSubscriptionRow, matchesEventType, openSecret, parseEventTypes, type SubscriptionRow } from "./subscriptions";
import { isAllowedWebhookUrl } from "./url";

/**
 * Webhook fan-out + delivery.
 *
 *   fanOutNewEvents(limit)   events newer than the `webhook_cursors` watermark
 *                            → one queued delivery per matching subscription
 *   deliverPending(limit)    POST due deliveries, apply backoff / dead / auto-disable
 *
 * Both are called from the cron tick. Payloads are serialised once at fan-out
 * time and re-sent byte-for-byte on retry so the signature stays valid.
 */

export interface EventRow {
  id: string;
  user_id: string;
  type: string;
  entity: string;
  entity_id: string;
  data: string | null;
  created_at: string | Date;
}

export interface DeliveryRow {
  id: string;
  user_id: string;
  subscription_id: string;
  event_id: string | null;
  event_type: string;
  payload: string;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: string | Date;
  response_status: number | null;
  response_ms: number | null;
  error: string | null;
  created_at: string | Date;
  delivered_at: string | Date | null;
}

export interface DeliveryDTO {
  id: string;
  subscription_id: string;
  event_id: string | null;
  event_type: string;
  payload: unknown;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: string | null;
  response_status: number | null;
  response_ms: number | null;
  error: string | null;
  created_at: string;
  delivered_at: string | null;
}

const DELIVERY_COLS =
  "id, user_id, subscription_id, event_id, event_type, payload, status, attempts, next_attempt_at, response_status, response_ms, error, created_at, delivered_at";

const iso = (v: string | Date | null | undefined): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

export function toDeliveryDTO(r: DeliveryRow): DeliveryDTO {
  let payload: unknown = null;
  try {
    payload = JSON.parse(r.payload);
  } catch {
    payload = r.payload;
  }
  return {
    id: r.id,
    subscription_id: r.subscription_id,
    event_id: r.event_id,
    event_type: r.event_type,
    payload,
    status: r.status,
    attempts: Number(r.attempts ?? 0),
    next_attempt_at: iso(r.next_attempt_at),
    response_status: r.response_status == null ? null : Number(r.response_status),
    response_ms: r.response_ms == null ? null : Number(r.response_ms),
    error: r.error,
    created_at: iso(r.created_at) ?? "",
    delivered_at: iso(r.delivered_at),
  };
}

/* ─── Payloads ─────────────────────────────────────────────────────────── */

export interface WebhookPayload {
  /** Delivery id (unique per subscription × event). */
  id: string;
  type: string;
  created_at: string;
  entity: string;
  entity_id: string;
  data: Record<string, unknown>;
}

function parseData(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function buildPayload(deliveryId: string, evt: Pick<EventRow, "type" | "entity" | "entity_id" | "data" | "created_at">): WebhookPayload {
  return {
    id: deliveryId,
    type: evt.type,
    created_at: iso(evt.created_at) ?? new Date().toISOString(),
    entity: evt.entity,
    entity_id: evt.entity_id,
    data: parseData(evt.data),
  };
}

const SAMPLE_DATA: Record<string, Record<string, unknown>> = {
  "crm.contact.created": { lifecycle: "lead", source: "api" },
  "crm.contact.stage_changed": { from: "lead", to: "customer" },
  "lead.captured": { email: "ada@example.com", source: "site" },
  "task.created": { title: "Call Ada back" },
  "quote.created": { number: "Q-0042", total_minor: 125000, currency: "USD", contact_id: "c_123" },
  "quote.sent": { number: "Q-0042", to: "ada@example.com", total_minor: 125000, currency: "USD" },
  "quote.declined": { number: "Q-0042" },
  "quote.expired": { number: "Q-0042" },
  "invoice.created": { number: "INV-0042", total_minor: 125000, currency: "USD", contact_id: "c_123", quote_id: null },
  "invoice.sent": { number: "INV-0042", to: "ada@example.com", total_minor: 125000, currency: "USD" },
  "invoice.paid": { total_minor: 125000, quote_id: null },
  "booking.created": { name: "Ada Lovelace", email: "ada@example.com", startsAt: "2026-11-10T15:00:00.000Z", endsAt: "2026-11-10T15:30:00.000Z", bookingTypeId: "bt_1", source: "public", contactId: "c_123" },
  "booking.cancelled": { name: "Ada Lovelace", startsAt: "2026-11-10T15:00:00.000Z", reason: null },
  "record.created": { type: "deals", stage: "new", title: "Acme renewal" },
  "record.moved": { type: "deals", from: "new", to: "won", title: "Acme renewal" },
  "ticket.created": { number: 17, subject: "Cannot log in", priority: "normal", source: "portal", requester_email: "ada@example.com" },
  "ticket.replied": { number: 17, author_kind: "agent", status: "pending", message_id: "m_1" },
  "ticket.resolved": { number: 17 },
  "ticket.sla_breached": { number: 17, kind: "first_response" },
  "product.created": { name: "Widget", sku: "WID-1", kind: "product" },
  "product.stock_changed": { kind: "receive", qty: 10, stock_on_hand: 25, stock_available: 22, low_stock: false },
  "webhook.test": { message: "This is a test delivery from KernelHub." },
};

const ENTITY_FOR_PREFIX: Record<string, string> = {
  crm: "crm_contact",
  lead: "lead",
  task: "task",
  quote: "quote",
  invoice: "invoice",
  booking: "booking",
  record: "record",
  ticket: "ticket",
  product: "product",
  production: "card",
  message: "message",
  social: "post",
  webhook: "webhook",
};

/** Representative payload for docs, Zapier "perform list" and the settings page. */
export function samplePayload(eventType: string): WebhookPayload {
  const prefix = eventType.split(".")[0];
  return {
    id: "dlv_sample",
    type: eventType,
    created_at: new Date().toISOString(),
    entity: ENTITY_FOR_PREFIX[prefix] ?? prefix,
    entity_id: "sample_id",
    data: SAMPLE_DATA[eventType] ?? {},
  };
}

/* ─── Fan-out ──────────────────────────────────────────────────────────── */

const CURSOR_NAME = "events";

async function activeSubscriptionsFor(userId: string): Promise<SubscriptionRow[]> {
  return query<SubscriptionRow>(
    `SELECT id, user_id, url, secret, event_types, active, description, created_by, created_at, last_success_at, last_failure_at, failure_count
       FROM webhook_subscriptions WHERE user_id = $1 AND active = TRUE`,
    [userId]
  );
}

/** Create queued deliveries for every active subscription that matches `evt`. Returns the count created. */
export async function fanOutEvent(evt: EventRow, subs?: SubscriptionRow[]): Promise<number> {
  const candidates = subs ?? (await activeSubscriptionsFor(evt.user_id));
  let created = 0;
  for (const sub of candidates) {
    if (!matchesEventType(parseEventTypes(sub.event_types), evt.type)) continue;
    const id = randomUUID();
    const payload = JSON.stringify(buildPayload(id, evt));
    await query(
      `INSERT INTO webhook_deliveries (id, user_id, subscription_id, event_id, event_type, payload, status, attempts, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'queued', 0, NOW())`,
      [id, evt.user_id, sub.id, evt.id, evt.type, payload]
    );
    created++;
  }
  return created;
}

export interface FanOutResult {
  scanned: number;
  created: number;
}

/**
 * Turn new `events` rows into deliveries. The watermark is (created_at, id)
 * of the last processed event, stored in `webhook_cursors`. On first run the
 * watermark starts at "now" so historic events are not replayed.
 */
export async function fanOutNewEvents(limit = 200): Promise<FanOutResult> {
  const cur = await queryOne<{ last_event_at: string | Date | null; last_event_id: string | null }>(
    `SELECT last_event_at, last_event_id FROM webhook_cursors WHERE name = $1`,
    [CURSOR_NAME]
  );
  if (!cur) {
    await query(`INSERT INTO webhook_cursors (name, last_event_at, last_event_id, updated_at) VALUES ($1, NOW(), '', NOW())`, [CURSOR_NAME]).catch(() => undefined);
    return { scanned: 0, created: 0 };
  }
  const since = iso(cur.last_event_at) ?? new Date(0).toISOString();
  const sinceId = cur.last_event_id ?? "";
  const events = await query<EventRow>(
    `SELECT id, user_id, type, entity, entity_id, data, created_at FROM events
      WHERE (created_at > $1 OR (created_at = $1 AND id > $2))
      ORDER BY created_at ASC, id ASC LIMIT $3`,
    [since, sinceId, Math.min(Math.max(limit, 1), 1000)]
  );
  if (events.length === 0) return { scanned: 0, created: 0 };

  const subsByUser = new Map<string, SubscriptionRow[]>();
  let created = 0;
  for (const evt of events) {
    let subs = subsByUser.get(evt.user_id);
    if (!subs) {
      subs = await activeSubscriptionsFor(evt.user_id);
      subsByUser.set(evt.user_id, subs);
    }
    if (subs.length) created += await fanOutEvent(evt, subs);
  }
  const last = events[events.length - 1];
  await query(`UPDATE webhook_cursors SET last_event_at = $2, last_event_id = $3, updated_at = NOW() WHERE name = $1`, [CURSOR_NAME, iso(last.created_at), last.id]);
  return { scanned: events.length, created };
}

/* ─── Delivery ─────────────────────────────────────────────────────────── */

export interface SendOutcome {
  ok: boolean;
  status: number;
  ms: number;
  error?: string;
}

/** POST one signed payload. Never throws. */
export async function sendWebhook(
  url: string,
  secret: string,
  payload: string,
  headers: { event: string; delivery: string },
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; now?: number } = {}
): Promise<SendOutcome> {
  if (!isAllowedWebhookUrl(url)) return { ok: false, status: 0, ms: 0, error: "endpoint URL not allowed" };
  const doFetch = opts.fetchImpl ?? fetch;
  const started = Date.now();
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "KernelHub-Webhooks/1.0",
        [SIGNATURE_HEADER]: signPayload(secret, payload, opts.now ?? Math.floor(Date.now() / 1000)),
        [EVENT_HEADER]: headers.event,
        [DELIVERY_HEADER]: headers.delivery,
      },
      body: payload,
      redirect: "error",
      signal: AbortSignal.timeout(opts.timeoutMs ?? DELIVERY_TIMEOUT_MS),
    });
    const ms = Date.now() - started;
    if (isSuccessStatus(res.status)) return { ok: true, status: res.status, ms };
    const text = await res.text().catch(() => "");
    return { ok: false, status: res.status, ms, error: (text.slice(0, 300) || res.statusText || `HTTP ${res.status}`).trim() };
  } catch (err) {
    const ms = Date.now() - started;
    const message = err instanceof Error ? (err.name === "TimeoutError" ? `timeout after ${opts.timeoutMs ?? DELIVERY_TIMEOUT_MS}ms` : err.message) : String(err);
    return { ok: false, status: 0, ms, error: message.slice(0, 300) };
  }
}

async function claimDelivery(id: string): Promise<DeliveryRow | null> {
  return queryOne<DeliveryRow>(
    `UPDATE webhook_deliveries SET status = 'delivering', attempts = attempts + 1
      WHERE id = $1 AND status IN ('queued', 'failed') AND next_attempt_at <= NOW()
      RETURNING ${DELIVERY_COLS}`,
    [id]
  );
}

async function finishDelivery(d: DeliveryRow, sub: SubscriptionRow, out: SendOutcome): Promise<DeliveryStatus> {
  if (out.ok) {
    await query(
      `UPDATE webhook_deliveries SET status = 'delivered', response_status = $2, response_ms = $3, error = NULL, delivered_at = NOW() WHERE id = $1`,
      [d.id, out.status, out.ms]
    );
    await query(`UPDATE webhook_subscriptions SET last_success_at = NOW(), failure_count = 0 WHERE id = $1`, [sub.id]);
    return "delivered";
  }
  const next = afterFailure(Number(d.attempts));
  await query(
    `UPDATE webhook_deliveries SET status = $2, next_attempt_at = COALESCE($3, next_attempt_at), response_status = $4, response_ms = $5, error = $6 WHERE id = $1`,
    [d.id, next.status, next.nextAttemptAt?.toISOString() ?? null, out.status || null, out.ms, out.error ?? null]
  );
  const failures = Number(sub.failure_count ?? 0) + 1;
  const disable = shouldAutoDisable(failures);
  await query(
    `UPDATE webhook_subscriptions SET last_failure_at = NOW(), failure_count = failure_count + 1${disable ? ", active = FALSE" : ""} WHERE id = $1`,
    [sub.id]
  );
  if (disable) console.warn(`[webhooks] subscription ${sub.id} disabled after ${AUTO_DISABLE_AFTER} consecutive failures`);
  return next.status;
}

export interface DeliverResult {
  claimed: number;
  delivered: number;
  failed: number;
  dead: number;
}

/** Send every due delivery (oldest first). Safe to call concurrently: claims are conditional updates. */
export async function deliverPending(limit = 50, opts: { fetchImpl?: typeof fetch } = {}): Promise<DeliverResult> {
  const result: DeliverResult = { claimed: 0, delivered: 0, failed: 0, dead: 0 };
  const due = await query<{ id: string }>(
    `SELECT id FROM webhook_deliveries WHERE status IN ('queued', 'failed') AND next_attempt_at <= NOW() ORDER BY next_attempt_at ASC LIMIT $1`,
    [Math.min(Math.max(limit, 1), 500)]
  );
  const subCache = new Map<string, SubscriptionRow | null>();
  for (const { id } of due) {
    const d = await claimDelivery(id);
    if (!d) continue;
    result.claimed++;
    let sub = subCache.get(d.subscription_id);
    if (sub === undefined) {
      sub = await getSubscriptionRow(d.user_id, d.subscription_id);
      subCache.set(d.subscription_id, sub);
    }
    if (!sub || !sub.active) {
      await query(`UPDATE webhook_deliveries SET status = 'dead', error = $2 WHERE id = $1`, [d.id, sub ? "subscription disabled" : "subscription deleted"]);
      result.dead++;
      continue;
    }
    const secret = openSecret(sub.secret);
    if (!secret) {
      await query(`UPDATE webhook_deliveries SET status = 'dead', error = 'secret cannot be decrypted (CREDENTIAL_ENCRYPTION_KEY changed?)' WHERE id = $1`, [d.id]);
      result.dead++;
      continue;
    }
    const out = await sendWebhook(sub.url, secret, d.payload, { event: d.event_type, delivery: d.id }, { fetchImpl: opts.fetchImpl });
    const status = await finishDelivery(d, sub, out);
    if (status === "delivered") result.delivered++;
    else if (status === "dead") result.dead++;
    else result.failed++;
    // Keep the cached failure_count in step for subsequent deliveries to the same endpoint this tick.
    subCache.set(sub.id, { ...sub, failure_count: out.ok ? 0 : Number(sub.failure_count ?? 0) + 1, active: out.ok ? sub.active : !shouldAutoDisable(Number(sub.failure_count ?? 0) + 1) });
  }
  return result;
}

/* ─── Manual actions ───────────────────────────────────────────────────── */

export async function listDeliveries(dataId: string, subscriptionId: string, limit = 50): Promise<DeliveryDTO[]> {
  const rows = await query<DeliveryRow>(
    `SELECT ${DELIVERY_COLS} FROM webhook_deliveries WHERE user_id = $1 AND subscription_id = $2 ORDER BY created_at DESC LIMIT $3`,
    [dataId, subscriptionId, Math.min(Math.max(limit, 1), 200)]
  );
  return rows.map(toDeliveryDTO);
}

export async function getDelivery(dataId: string, subscriptionId: string, deliveryId: string): Promise<DeliveryDTO | null> {
  const row = await queryOne<DeliveryRow>(`SELECT ${DELIVERY_COLS} FROM webhook_deliveries WHERE id = $1 AND user_id = $2 AND subscription_id = $3`, [
    deliveryId,
    dataId,
    subscriptionId,
  ]);
  return row ? toDeliveryDTO(row) : null;
}

/** Re-queue a failed/dead delivery immediately (attempt counter restarts). */
export async function retryDelivery(dataId: string, subscriptionId: string, deliveryId: string): Promise<DeliveryDTO | null> {
  const row = await queryOne<DeliveryRow>(
    `UPDATE webhook_deliveries SET status = 'queued', attempts = 0, next_attempt_at = NOW(), error = NULL
      WHERE id = $1 AND user_id = $2 AND subscription_id = $3 AND status IN ('failed', 'dead', 'delivered')
      RETURNING ${DELIVERY_COLS}`,
    [deliveryId, dataId, subscriptionId]
  );
  return row ? toDeliveryDTO(row) : null;
}

/** Send a `webhook.test` ping right now and record it as a delivery. */
export async function sendTestPing(dataId: string, subscriptionId: string, opts: { fetchImpl?: typeof fetch } = {}): Promise<DeliveryDTO> {
  const sub = await getSubscriptionRow(dataId, subscriptionId);
  if (!sub) throw new Error("Webhook not found");
  const secret = openSecret(sub.secret);
  if (!secret) throw new Error("Webhook secret cannot be decrypted; rotate the secret and try again");
  const id = randomUUID();
  const payload = JSON.stringify({ ...samplePayload("webhook.test"), id, entity_id: sub.id });
  await query(
    `INSERT INTO webhook_deliveries (id, user_id, subscription_id, event_id, event_type, payload, status, attempts, next_attempt_at)
     VALUES ($1, $2, $3, NULL, 'webhook.test', $4, 'delivering', 1, NOW())`,
    [id, dataId, sub.id, payload]
  );
  const out = await sendWebhook(sub.url, secret, payload, { event: "webhook.test", delivery: id }, { fetchImpl: opts.fetchImpl });
  if (out.ok) {
    await query(`UPDATE webhook_deliveries SET status = 'delivered', response_status = $2, response_ms = $3, delivered_at = NOW() WHERE id = $1`, [id, out.status, out.ms]);
    await query(`UPDATE webhook_subscriptions SET last_success_at = NOW(), failure_count = 0 WHERE id = $1`, [sub.id]);
  } else {
    // A test ping is not retried automatically; the user can retry from the UI.
    await query(`UPDATE webhook_deliveries SET status = 'dead', response_status = $2, response_ms = $3, error = $4 WHERE id = $1`, [id, out.status || null, out.ms, out.error ?? null]);
    await query(`UPDATE webhook_subscriptions SET last_failure_at = NOW() WHERE id = $1`, [sub.id]);
  }
  const row = await queryOne<DeliveryRow>(`SELECT ${DELIVERY_COLS} FROM webhook_deliveries WHERE id = $1`, [id]);
  if (!row) throw new Error("delivery vanished");
  return toDeliveryDTO(row);
}
