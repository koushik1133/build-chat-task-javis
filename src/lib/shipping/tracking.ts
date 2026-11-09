import { createHash } from "crypto";
import { query } from "@/lib/dsql";
import { tableExists } from "@/lib/table-exists";
import { credsFor, getProvider } from "./index";
import { simulatedEvents } from "./providers/simulated";
import { addShipmentEvent, applyShipmentStatus, getShipment, type ShipmentRow } from "./shipments";
import type { ShipmentStatus, TrackingEventInput } from "./types";

/** Tracking ingestion (idempotent), provider webhooks, the simulated-time advance and the real-provider poll. */

export interface IngestResult {
  inserted: boolean;
  changed: boolean;
  status: ShipmentStatus;
}

export function eventHash(ev: TrackingEventInput): string {
  return createHash("sha256").update(`${ev.status}|${ev.occurred_at}|${ev.description}|${ev.location ?? ""}`).digest("hex").slice(0, 32);
}

/**
 * Record one carrier event and move the shipment forward. Safe to replay: the
 * (shipment, occurred_at, status) key swallows duplicates and the status machine
 * never regresses, so delivered stays delivered whatever order events arrive in.
 */
export async function ingestTrackingEvent(dataId: string, shipmentId: string, ev: TrackingEventInput): Promise<IngestResult> {
  const at = new Date(ev.occurred_at);
  if (!Number.isFinite(at.getTime())) throw new Error("Invalid event time");
  const inserted = await addShipmentEvent(dataId, shipmentId, { status: ev.status, description: ev.description, location: ev.location, occurred_at: at.toISOString(), raw_hash: eventHash(ev) });
  const change = await applyShipmentStatus(dataId, shipmentId, ev.status);
  return { inserted, changed: change.changed, status: change.to };
}

/** Ingest a batch oldest-first so intermediate scans are recorded before the final status. */
export async function ingestTrackingEvents(dataId: string, shipmentId: string, events: TrackingEventInput[]): Promise<{ inserted: number; status: ShipmentStatus | null }> {
  const ordered = [...events].sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
  let inserted = 0;
  let status: ShipmentStatus | null = null;
  for (const ev of ordered) {
    const r = await ingestTrackingEvent(dataId, shipmentId, ev);
    if (r.inserted) inserted += 1;
    status = r.status;
  }
  return { inserted, status };
}

/* ── webhooks ──────────────────────────────────────────────────────────── */

export interface WebhookOutcome {
  ok: boolean;
  events: number;
  matched: number;
}

/** Verify and apply a provider webhook. `ok:false` means the signature failed (respond 401). */
export async function handleProviderWebhook(providerId: string, rawBody: string, headers: { get(name: string): string | null }, url?: URL): Promise<WebhookOutcome> {
  const provider = getProvider(providerId);
  if (!provider) return { ok: false, events: 0, matched: 0 };
  const parsed = provider.verifyWebhook(rawBody, headers, url);
  if (parsed === null) return { ok: false, events: 0, matched: 0 };
  let matched = 0;
  for (const p of parsed) {
    const rows = await query<{ id: string; user_id: string }>(`SELECT id, user_id FROM shipments WHERE tracking_number = $1 AND provider_ref LIKE $2 AND status <> 'void' LIMIT 5`, [p.tracking_number, `${providerId}:%`]);
    for (const s of rows) {
      matched += 1;
      await ingestTrackingEvent(s.user_id, s.id, p.event);
    }
  }
  return { ok: true, events: parsed.length, matched };
}

/* ── crons ─────────────────────────────────────────────────────────────── */

const ACTIVE = ["label_purchased", "in_transit", "out_for_delivery", "exception"];

/**
 * Dev/simulated only: walk simulated shipments through their scripted events by elapsed time.
 * Cron hook; `opts.now` lets tests jump the clock.
 */
export async function advanceSimulated(limit = 100, opts: { now?: Date } = {}): Promise<{ shipments: number; events: number }> {
  if (!(await tableExists("shipments"))) return { shipments: 0, events: 0 };
  const rows = await query<ShipmentRow>(
    `SELECT id, user_id, carrier, service, tracking_number, purchased_at, provider_ref, status FROM shipments WHERE provider_ref LIKE 'simulated:%' AND status = ANY($1::text[]) AND purchased_at IS NOT NULL ORDER BY updated_at ASC LIMIT $2`,
    [ACTIVE, Math.min(Math.max(limit, 1), 500)]
  );
  let events = 0;
  for (const s of rows) {
    const evs = simulatedEvents({ tracking_number: s.tracking_number ?? "", carrier: s.carrier, service: s.service, purchased_at: s.purchased_at ? new Date(s.purchased_at).toISOString() : null, provider_ref: s.provider_ref, now: opts.now });
    const r = await ingestTrackingEvents(s.user_id, s.id, evs);
    events += r.inserted;
    await query(`UPDATE shipments SET updated_at = NOW() WHERE id = $1 AND user_id = $2`, [s.id, s.user_id]);
  }
  return { shipments: rows.length, events };
}

/** Poll real carriers for shipments not delivered and not refreshed in the last 6 hours (bounded per tick). */
export async function syncTracking(limit = 50, opts: { olderThanMs?: number } = {}): Promise<{ polled: number; events: number; errors: number }> {
  if (!(await tableExists("shipments"))) return { polled: 0, events: 0, errors: 0 };
  const cutoff = new Date(Date.now() - (opts.olderThanMs ?? 6 * 3_600_000)).toISOString();
  const rows = await query<ShipmentRow>(
    `SELECT id, user_id, carrier, service, tracking_number, purchased_at, provider_ref, status FROM shipments
      WHERE provider_ref NOT LIKE 'simulated:%' AND provider_ref NOT LIKE 'manual:%' AND tracking_number IS NOT NULL AND status = ANY($1::text[]) AND updated_at < $2
      ORDER BY updated_at ASC LIMIT $3`,
    [ACTIVE.filter((s) => s !== "exception"), cutoff, Math.min(Math.max(limit, 1), 200)]
  );
  let events = 0;
  let errors = 0;
  for (const s of rows) {
    const providerId = s.provider_ref?.split(":")[0] ?? "";
    const provider = getProvider(providerId);
    if (!provider || !s.tracking_number) continue;
    try {
      const creds = await credsFor(s.user_id, providerId);
      const evs = await provider.track({ tracking_number: s.tracking_number, carrier: s.carrier, service: s.service, purchased_at: s.purchased_at ? new Date(s.purchased_at).toISOString() : null, provider_ref: s.provider_ref }, creds);
      events += (await ingestTrackingEvents(s.user_id, s.id, evs)).inserted;
    } catch (err) {
      errors += 1;
      console.error(`[shipping] tracking sync failed for ${s.id}:`, err instanceof Error ? err.message : err);
    }
    // Touch even on failure so one broken shipment cannot starve the rest of the batch.
    await query(`UPDATE shipments SET updated_at = NOW() WHERE id = $1 AND user_id = $2`, [s.id, s.user_id]).catch(() => undefined);
  }
  return { polled: rows.length, events, errors };
}

export { getShipment };
