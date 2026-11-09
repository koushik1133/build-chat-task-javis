import { randomUUID } from "crypto";
import { query } from "@/lib/dsql";
import { enqueueJob } from "@/lib/agents/queue";
import type { EventRecord } from "@/lib/agents/types";

/**
 * Append-only event log + trigger fan-out.
 *
 * Call sites emit one line (`emitEvent(userId, {...})`) and never know who is
 * listening. Matching `agent_triggers` of kind "event" become queued runs;
 * the worker tick picks them up.
 *
 * Emitting must never break the caller: every failure is logged and swallowed.
 */
export async function emitEvent(userId: string, evt: EventRecord): Promise<void> {
  const id = randomUUID();
  try {
    await query(
      `INSERT INTO events (id, user_id, type, entity, entity_id, data)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, userId, evt.type, evt.entity, evt.entityId, JSON.stringify(evt.data ?? {})]
    );
  } catch (err) {
    console.error(`[events] failed to record ${evt.type}:`, err);
    return;
  }

  try {
    const triggers = await query<{ id: string; agent_id: string; config: string | null }>(
      `SELECT id, agent_id, config FROM agent_triggers
       WHERE user_id = $1 AND kind = 'event' AND enabled = TRUE AND event_type = $2`,
      [userId, evt.type]
    );

    for (const t of triggers) {
      const runId = randomUUID();
      await query(
        `INSERT INTO agent_runs (id, user_id, agent_id, status, trigger_kind, trigger_ref, prompt, output)
         VALUES ($1, $2, $3, 'queued', 'event', $4, $5, '')`,
        [
          runId,
          userId,
          t.agent_id,
          t.id,
          `Event ${evt.type} on ${evt.entity} ${evt.entityId}: ${JSON.stringify(evt.data ?? {}).slice(0, 2000)}`,
        ]
      );
      await enqueueJob(userId, { kind: "run", runId });
      await query(`UPDATE agent_triggers SET last_run_at = NOW() WHERE id = $1`, [t.id]);
    }
  } catch (err) {
    console.error(`[events] trigger fan-out failed for ${evt.type}:`, err);
  }
}

/** Well-known event types. Keep additions here so triggers can offer a picker. */
export const EVENT_TYPES = [
  "tax.filing_due",
  "einvoice.accepted",
  "crm.contact.created",
  "crm.contact.stage_changed",
  "lead.captured",
  "lead.enriched",
  "production.card.moved",
  "production.card.approved",
  "production.card.rejected",
  "message.received",
  "message.sent",
  "social.post.published",
  "social.post.failed",
  "task.created",
  "invoice.paid",
  "booking.created",
  "booking.cancelled",
  "booking.rescheduled",
  "record.created",
  "record.moved",
  "ticket.created",
  "ticket.resolved",
  "ticket.sla_breached",
  "quote.declined",
  "quote.expired",
  "ticket.replied",
  "quote.created",
  "quote.sent",
  "invoice.created",
  "invoice.sent",
  "invoice.overdue",
  "product.created",
  "product.stock_changed",
  "stock.transfer_shipped",
  "stock.transfer_received",
  "expense.created",
  "accounting.synced",
  "accounting.sync_failed",
  "webchat.session_started",
  "webchat.handoff_requested",
  "shift.published",
  "shift.reminded",
  "shift.swap_requested",
  "leave.requested",
  "leave.decided",
  "purchase_order.sent",
  "purchase_order.received",
  "supplier_bill.created",
  "supplier_bill.paid",
  "document.sent",
  "document.viewed",
  "document.signed",
  "document.declined",
  "document.expired",
  "attachment.added",
  "privacy.dsr.received",
  "marketplace.installed",
  "snapshot.applied",
  "automation.run_finished",
  "automation.run_failed",
  "order.created",
  "order.paid",
  "order.fulfilled",
  "order.unfulfilled",
  "order.cancelled",
  "cart.abandoned",
  "project.created",
  "project.status_changed",
  "milestone.completed",
  "task.overdue",
  "portal.message_received",
  "calsync.error",
  "chat.delivery_failed",
  "subscription.created",
  "subscription.renewed",
  "subscription.past_due",
  "subscription.cancelled",
  "subscription.plan_changed",
  "membership.subscribed",
  "membership.renewed",
  "membership.payment_failed",
  "membership.paused",
  "membership.cancelled",
  "membership.trial_ending",
  "order.delivered",
  "shipment.created",
  "shipment.shipped",
  "shipment.delivered",
  "shipment.exception",
  "return.requested",
  "return.approved",
  "return.refunded",
  "survey.completed",
  "survey.detractor",
  "loyalty.tier_changed",
  "gift_card.issued",
  "voucher.redeemed",
  "referral.rewarded",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];
