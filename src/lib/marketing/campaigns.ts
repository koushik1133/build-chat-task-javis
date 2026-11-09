import { randomUUID } from "crypto";
import { query, queryOne, withRetry } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";
import { currentConsent, grantedSubset, recordConsent } from "@/lib/privacy/consent";
import { keysetClause, keysetOrder, type Cursor } from "@/lib/public-api/pagination";
import { getAudience, resolveAudience, type AudienceContact } from "./audiences";
import { loadContact, sendMarketingMessage } from "./send";
import { getTemplate } from "./templates";
import { CONSENT_PURPOSE_FOR_CHANNEL, computeCampaignStats, parseAudienceDefinition, type CampaignStats, type CampaignStatus, type MarketingSendChannel, type RecipientStatus } from "./types";

/**
 * Campaign lifecycle:
 *   draft → (launch) → sending → (all recipients handed off) → sent
 *   draft → (schedule) → scheduled → (cron, schedule_at <= now) → sending
 *   sending ⇄ paused; any non-final → cancelled
 *
 * `launchCampaign` materialises recipients and applies the consent gate per
 * contact (no consent → skipped_no_consent, never sent). `sendBatch` is the
 * cron worker: it claims queued recipients with a conditional UPDATE so two
 * ticks never double-send, and hands each to the outbox tagged `marketing`.
 */

export interface CampaignRow {
  id: string;
  user_id: string;
  name: string;
  channel: MarketingSendChannel;
  audience_id: string | null;
  template_id: string | null;
  subject: string | null;
  preheader: string | null;
  body_md: string;
  from_name: string | null;
  reply_to: string | null;
  status: CampaignStatus;
  schedule_at: string | null;
  sent_count: number;
  delivered_count: number;
  opened_count: number;
  clicked_count: number;
  bounced_count: number;
  unsubscribed_count: number;
  skipped_count: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface RecipientRow {
  id: string;
  user_id: string;
  campaign_id: string;
  contact_id: string;
  email: string | null;
  phone: string | null;
  status: RecipientStatus;
  outbox_id: string | null;
  sent_at: string | null;
  opened_at: string | null;
  clicked_at: string | null;
  error: string | null;
  created_at: string;
}

export const CAMPAIGN_COLS = `id, user_id, name, channel, audience_id, template_id, subject, preheader, body_md, from_name, reply_to, status, schedule_at,
  sent_count, delivered_count, opened_count, clicked_count, bounced_count, unsubscribed_count, skipped_count, created_by, created_at, updated_at, started_at, finished_at`;
const RECIPIENT_COLS = `id, user_id, campaign_id, contact_id, email, phone, status, outbox_id, sent_at, opened_at, clicked_at, error, created_at`;

export class CampaignError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "invalid_state" | "no_audience" | "no_eligible" | "no_content"
  ) {
    super(message);
    this.name = "CampaignError";
  }
}

export interface CampaignInput {
  name: string;
  channel: MarketingSendChannel;
  audience_id?: string | null;
  template_id?: string | null;
  subject?: string | null;
  preheader?: string | null;
  body_md?: string | null;
  from_name?: string | null;
  reply_to?: string | null;
  schedule_at?: string | null;
}

export async function listCampaigns(dataId: string, opts: { status?: CampaignStatus | null; limit?: number; cursor?: Cursor | null } = {}): Promise<CampaignRow[]> {
  const params: unknown[] = [dataId];
  const where = ["user_id = $1"];
  if (opts.status) {
    params.push(opts.status);
    where.push(`status = $${params.length}`);
  }
  const keyset = keysetClause(opts.cursor, params);
  params.push(Math.max(1, Math.min(201, opts.limit ?? 100)));
  return query<CampaignRow>(`SELECT ${CAMPAIGN_COLS} FROM campaigns WHERE ${where.join(" AND ")}${keyset} ORDER BY ${keysetOrder()} LIMIT $${params.length}`, params);
}

export async function getCampaign(dataId: string, id: string): Promise<CampaignRow | null> {
  return queryOne<CampaignRow>(`SELECT ${CAMPAIGN_COLS} FROM campaigns WHERE user_id = $1 AND id = $2`, [dataId, id]);
}

/** Resolve subject/body from the template when the campaign has none of its own. */
async function resolveContent(dataId: string, input: Pick<CampaignInput, "template_id" | "subject" | "preheader" | "body_md">): Promise<{ subject: string | null; preheader: string | null; body_md: string }> {
  const tpl = input.template_id ? await getTemplate(dataId, input.template_id) : null;
  return {
    subject: input.subject?.trim() || tpl?.subject || null,
    preheader: input.preheader?.trim() || tpl?.preheader || null,
    body_md: input.body_md?.trim() || tpl?.body_md || "",
  };
}

export async function createCampaign(dataId: string, input: CampaignInput, createdBy: string | null): Promise<CampaignRow> {
  const content = await resolveContent(dataId, input);
  const status: CampaignStatus = "draft";
  const row = await queryOne<CampaignRow>(
    `INSERT INTO campaigns (id, user_id, name, channel, audience_id, template_id, subject, preheader, body_md, from_name, reply_to, status, schedule_at, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), NOW()) RETURNING ${CAMPAIGN_COLS}`,
    [randomUUID(), dataId, input.name.trim(), input.channel, input.audience_id ?? null, input.template_id ?? null, content.subject, content.preheader, content.body_md, input.from_name?.trim() || null, input.reply_to?.trim() || null, status, input.schedule_at ?? null, createdBy]
  );
  if (!row) throw new Error("campaign insert returned no row");
  return row;
}

export async function updateCampaign(dataId: string, id: string, patch: Partial<CampaignInput>): Promise<CampaignRow> {
  const cur = await getCampaign(dataId, id);
  if (!cur) throw new CampaignError("Campaign not found", "not_found");
  if (cur.status !== "draft" && cur.status !== "scheduled" && cur.status !== "paused") throw new CampaignError(`A ${cur.status} campaign cannot be edited`, "invalid_state");
  const content = await resolveContent(dataId, {
    template_id: patch.template_id === undefined ? cur.template_id : patch.template_id,
    subject: patch.subject === undefined ? cur.subject : patch.subject,
    preheader: patch.preheader === undefined ? cur.preheader : patch.preheader,
    body_md: patch.body_md === undefined ? cur.body_md : patch.body_md,
  });
  const row = await queryOne<CampaignRow>(
    `UPDATE campaigns SET name = $3, channel = $4, audience_id = $5, template_id = $6, subject = $7, preheader = $8, body_md = $9, from_name = $10, reply_to = $11, schedule_at = $12, updated_at = NOW()
      WHERE user_id = $1 AND id = $2 RETURNING ${CAMPAIGN_COLS}`,
    [
      dataId,
      id,
      (patch.name ?? cur.name).trim(),
      patch.channel ?? cur.channel,
      patch.audience_id === undefined ? cur.audience_id : patch.audience_id,
      patch.template_id === undefined ? cur.template_id : patch.template_id,
      content.subject,
      content.preheader,
      content.body_md,
      patch.from_name === undefined ? cur.from_name : patch.from_name?.trim() || null,
      patch.reply_to === undefined ? cur.reply_to : patch.reply_to?.trim() || null,
      patch.schedule_at === undefined ? cur.schedule_at : patch.schedule_at,
    ]
  );
  if (!row) throw new CampaignError("Campaign not found", "not_found");
  return row;
}

export async function deleteCampaign(dataId: string, id: string): Promise<boolean> {
  const cur = await getCampaign(dataId, id);
  if (!cur) return false;
  if (cur.status === "sending") throw new CampaignError("Pause or cancel the campaign before deleting it", "invalid_state");
  await query(`DELETE FROM campaign_recipients WHERE user_id = $1 AND campaign_id = $2`, [dataId, id]);
  await query(`DELETE FROM link_clicks WHERE user_id = $1 AND campaign_id = $2`, [dataId, id]);
  await query(`DELETE FROM campaigns WHERE user_id = $1 AND id = $2`, [dataId, id]);
  return true;
}

/* ---------- launch ---------- */

export interface LaunchResult {
  campaign: CampaignRow;
  queued: number;
  skipped_no_consent: number;
  skipped_no_address: number;
}

/**
 * Materialise recipients from the audience and move the campaign to
 * `sending` (or `scheduled` when schedule_at is in the future). Every contact
 * is gated: no current consent for the channel → `skipped_no_consent`.
 * Refuses to launch when zero contacts are eligible.
 */
export async function launchCampaign(dataId: string, id: string, opts: { force?: boolean } = {}): Promise<LaunchResult> {
  const campaign = await getCampaign(dataId, id);
  if (!campaign) throw new CampaignError("Campaign not found", "not_found");
  if (campaign.status !== "draft" && campaign.status !== "scheduled" && campaign.status !== "paused") throw new CampaignError(`A ${campaign.status} campaign cannot be launched`, "invalid_state");
  if (!campaign.body_md.trim()) throw new CampaignError("Add content before launching", "no_content");
  if (campaign.channel === "email" && !campaign.subject?.trim()) throw new CampaignError("Email campaigns need a subject", "no_content");
  if (!campaign.audience_id) throw new CampaignError("Pick an audience before launching", "no_audience");
  const audience = await getAudience(dataId, campaign.audience_id);
  if (!audience) throw new CampaignError("The audience no longer exists", "no_audience");

  // Resuming a paused campaign keeps its recipient rows.
  const existing = await queryOne<{ n: string }>(`SELECT COUNT(*)::text AS n FROM campaign_recipients WHERE user_id = $1 AND campaign_id = $2`, [dataId, id]);
  let queued = 0;
  let skippedConsent = 0;
  let skippedAddress = 0;
  if (parseInt(existing?.n ?? "0", 10) === 0) {
    const contacts = await resolveAudience(dataId, parseAudienceDefinition(audience.definition), { limit: 5000 });
    const purpose = CONSENT_PURPOSE_FOR_CHANNEL[campaign.channel];
    const granted = await grantedSubset(dataId, "contact", contacts.map((c) => c.id), purpose);
    for (const c of contacts) {
      const address = campaign.channel === "email" ? c.email?.trim() : c.phone?.trim();
      if (!address) {
        skippedAddress++;
        continue;
      }
      // Consent-first: the ledger decides here; opt-outs/tombstones are re-checked at send time.
      const status: RecipientStatus = granted.has(c.id) ? "queued" : "skipped_no_consent";
      if (status === "queued") queued++;
      else skippedConsent++;
      await query(
        `INSERT INTO campaign_recipients (id, user_id, campaign_id, contact_id, email, phone, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [randomUUID(), dataId, id, c.id, c.email, c.phone, status]
      ).catch(() => undefined); // UNIQUE (campaign_id, contact_id)
    }
    if (queued === 0 && !opts.force) {
      await query(`DELETE FROM campaign_recipients WHERE user_id = $1 AND campaign_id = $2`, [dataId, id]);
      throw new CampaignError(
        skippedConsent > 0
          ? `None of the ${contacts.length} contacts in this audience has consented to marketing by ${campaign.channel}. Record consent first or choose another audience.`
          : "No contacts in this audience can be reached on this channel.",
        "no_eligible"
      );
    }
  } else {
    const q = await queryOne<{ n: string }>(`SELECT COUNT(*)::text AS n FROM campaign_recipients WHERE user_id = $1 AND campaign_id = $2 AND status = 'queued'`, [dataId, id]);
    queued = parseInt(q?.n ?? "0", 10);
  }

  const future = campaign.schedule_at && new Date(campaign.schedule_at).getTime() > Date.now() + 30_000;
  const next: CampaignStatus = future ? "scheduled" : "sending";
  const updated = await queryOne<CampaignRow>(
    `UPDATE campaigns SET status = $3, skipped_count = skipped_count + $4, started_at = COALESCE(started_at, CASE WHEN $3 = 'sending' THEN NOW() ELSE NULL END), updated_at = NOW()
      WHERE user_id = $1 AND id = $2 RETURNING ${CAMPAIGN_COLS}`,
    [dataId, id, next, skippedConsent]
  );
  return { campaign: updated ?? campaign, queued, skipped_no_consent: skippedConsent, skipped_no_address: skippedAddress };
}

export async function pauseCampaign(dataId: string, id: string): Promise<CampaignRow> {
  const cur = await getCampaign(dataId, id);
  if (!cur) throw new CampaignError("Campaign not found", "not_found");
  if (cur.status !== "sending" && cur.status !== "scheduled") throw new CampaignError(`A ${cur.status} campaign cannot be paused`, "invalid_state");
  const row = await queryOne<CampaignRow>(`UPDATE campaigns SET status = 'paused', updated_at = NOW() WHERE user_id = $1 AND id = $2 RETURNING ${CAMPAIGN_COLS}`, [dataId, id]);
  return row ?? cur;
}

export async function cancelCampaign(dataId: string, id: string): Promise<CampaignRow> {
  const cur = await getCampaign(dataId, id);
  if (!cur) throw new CampaignError("Campaign not found", "not_found");
  if (cur.status === "sent" || cur.status === "cancelled") throw new CampaignError(`A ${cur.status} campaign cannot be cancelled`, "invalid_state");
  await query(`UPDATE campaign_recipients SET status = 'failed', error = 'campaign cancelled' WHERE user_id = $1 AND campaign_id = $2 AND status = 'queued'`, [dataId, id]);
  const row = await queryOne<CampaignRow>(`UPDATE campaigns SET status = 'cancelled', finished_at = NOW(), updated_at = NOW() WHERE user_id = $1 AND id = $2 RETURNING ${CAMPAIGN_COLS}`, [dataId, id]);
  return row ?? cur;
}

/* ---------- cron: send ---------- */

export interface SendBatchResult {
  claimed: number;
  sent: number;
  skipped: number;
  failed: number;
  campaigns_finished: number;
  campaigns_started: number;
}

/**
 * Cron worker. Promotes due `scheduled` campaigns, then claims up to `limit`
 * queued recipients of `sending` campaigns, renders and enqueues each through
 * the consent-checked send path, and closes campaigns with nothing left.
 * Never throws.
 */
export async function sendBatch(limit = 100): Promise<SendBatchResult> {
  const result: SendBatchResult = { claimed: 0, sent: 0, skipped: 0, failed: 0, campaigns_finished: 0, campaigns_started: 0 };
  try {
    const started = await query<{ id: string }>(
      `UPDATE campaigns SET status = 'sending', started_at = COALESCE(started_at, NOW()), updated_at = NOW() WHERE status = 'scheduled' AND schedule_at IS NOT NULL AND schedule_at <= NOW() RETURNING id`
    );
    result.campaigns_started = started.length;
  } catch (err) {
    console.error("[marketing] could not promote scheduled campaigns:", err);
  }

  let due: Array<{ id: string }> = [];
  try {
    due = await query<{ id: string }>(
      `SELECT r.id FROM campaign_recipients r JOIN campaigns c ON c.id = r.campaign_id
        WHERE r.status = 'queued' AND c.status = 'sending' ORDER BY r.created_at ASC LIMIT $1`,
      [Math.max(1, Math.min(1000, limit))]
    );
  } catch (err) {
    console.error("[marketing] could not list queued recipients:", err);
    return result;
  }

  const touched = new Set<string>();
  for (const { id } of due) {
    let rec: RecipientRow | null = null;
    try {
      rec = await withRetry(() => queryOne<RecipientRow>(`UPDATE campaign_recipients SET status = 'sent', sent_at = NOW() WHERE id = $1 AND status = 'queued' RETURNING ${RECIPIENT_COLS}`, [id]));
    } catch (err) {
      console.error(`[marketing] claim ${id} failed:`, err);
      continue;
    }
    if (!rec) continue;
    result.claimed++;
    touched.add(rec.campaign_id);
    try {
      const campaign = await getCampaign(rec.user_id, rec.campaign_id);
      const contact = campaign ? await loadContact(rec.user_id, rec.contact_id) : null;
      if (!campaign || !contact) {
        await query(`UPDATE campaign_recipients SET status = 'failed', error = $2 WHERE id = $1`, [rec.id, campaign ? "contact missing" : "campaign missing"]);
        result.failed++;
        continue;
      }
      const outcome = await sendMarketingMessage(rec.user_id, {
        channel: campaign.channel,
        contact,
        subject: campaign.subject,
        preheader: campaign.preheader,
        body_md: campaign.body_md,
        from_name: campaign.from_name,
        reply_to: campaign.reply_to,
        recipientId: rec.id,
        campaignId: campaign.id,
      });
      if (outcome.ok) {
        await query(`UPDATE campaign_recipients SET outbox_id = $2, error = NULL WHERE id = $1`, [rec.id, outcome.outboxId]);
        await query(`UPDATE campaigns SET sent_count = sent_count + 1, updated_at = NOW() WHERE id = $1`, [campaign.id]);
        result.sent++;
      } else if (outcome.reason === "no_consent" || outcome.reason === "opted_out" || outcome.reason === "tombstoned") {
        await query(`UPDATE campaign_recipients SET status = 'skipped_no_consent', sent_at = NULL, error = $2 WHERE id = $1`, [rec.id, outcome.reason]);
        await query(`UPDATE campaigns SET skipped_count = skipped_count + 1, updated_at = NOW() WHERE id = $1`, [campaign.id]);
        result.skipped++;
      } else {
        await query(`UPDATE campaign_recipients SET status = 'failed', error = $2 WHERE id = $1`, [rec.id, outcome.reason]);
        result.failed++;
      }
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      await query(`UPDATE campaign_recipients SET status = 'failed', error = $2 WHERE id = $1`, [rec.id, msg]).catch(() => undefined);
      result.failed++;
      console.error(`[marketing] send ${rec.id} failed:`, msg);
    }
  }

  // Close campaigns with no queued recipients left (also catches sending campaigns from earlier ticks).
  try {
    const finished = await query<{ id: string; user_id: string; name: string }>(
      `UPDATE campaigns c SET status = 'sent', finished_at = NOW(), updated_at = NOW()
        WHERE c.status = 'sending' AND NOT EXISTS (SELECT 1 FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.status = 'queued')
        RETURNING id, user_id, name`
    );
    result.campaigns_finished = finished.length;
    for (const f of finished) {
      const stats = await campaignStats(f.user_id, f.id).catch(() => null);
      await emitEvent(f.user_id, { type: "campaign.sent", entity: "campaign", entityId: f.id, data: { name: f.name, sent: stats?.sent ?? 0, delivered: stats?.delivered ?? 0, skipped_no_consent: stats?.skipped_no_consent ?? 0 } });
    }
  } catch (err) {
    console.error("[marketing] could not close campaigns:", err);
  }
  return result;
}

/* ---------- cron: delivery sync ---------- */

/**
 * Map outbox outcomes onto recipients: sent/simulated → delivered, failed →
 * bounced. Recipients that opened/clicked/unsubscribed keep that status.
 */
export async function syncDeliveryStatuses(limit = 500): Promise<{ delivered: number; bounced: number }> {
  const out = { delivered: 0, bounced: 0 };
  let rows: Array<{ id: string; campaign_id: string; outbox_status: string }> = [];
  try {
    rows = await query<{ id: string; campaign_id: string; outbox_status: string }>(
      `SELECT r.id, r.campaign_id, o.status AS outbox_status FROM campaign_recipients r JOIN notification_outbox o ON o.id = r.outbox_id
        WHERE r.status = 'sent' AND o.status IN ('sent', 'simulated', 'failed') ORDER BY r.sent_at ASC LIMIT $1`,
      [Math.max(1, Math.min(5000, limit))]
    );
  } catch (err) {
    console.error("[marketing] delivery sync query failed:", err);
    return out;
  }
  for (const r of rows) {
    const next: RecipientStatus = r.outbox_status === "failed" ? "bounced" : "delivered";
    const updated = await queryOne<{ id: string }>(`UPDATE campaign_recipients SET status = $2 WHERE id = $1 AND status = 'sent' RETURNING id`, [r.id, next]).catch(() => null);
    if (!updated) continue;
    if (next === "delivered") {
      out.delivered++;
      await query(`UPDATE campaigns SET delivered_count = delivered_count + 1, updated_at = NOW() WHERE id = $1`, [r.campaign_id]).catch(() => undefined);
    } else {
      out.bounced++;
      await query(`UPDATE campaigns SET bounced_count = bounced_count + 1, updated_at = NOW() WHERE id = $1`, [r.campaign_id]).catch(() => undefined);
    }
  }
  return out;
}

/* ---------- tracking hooks (public routes) ---------- */

export async function recordOpen(recipientId: string): Promise<boolean> {
  const row = await queryOne<{ campaign_id: string }>(
    `UPDATE campaign_recipients SET opened_at = NOW() WHERE id = $1 AND opened_at IS NULL AND status IN ('sent', 'delivered', 'unsubscribed') RETURNING campaign_id`,
    [recipientId]
  ).catch(() => null);
  if (!row) return false;
  await query(`UPDATE campaigns SET opened_count = opened_count + 1, updated_at = NOW() WHERE id = $1`, [row.campaign_id]).catch(() => undefined);
  return true;
}

export async function recordClick(recipientId: string, url: string): Promise<boolean> {
  const rec = await queryOne<{ id: string; user_id: string; campaign_id: string; clicked_at: string | null; opened_at: string | null }>(
    `SELECT id, user_id, campaign_id, clicked_at, opened_at FROM campaign_recipients WHERE id = $1`,
    [recipientId]
  ).catch(() => null);
  if (!rec) return false;
  await query(`INSERT INTO link_clicks (id, user_id, campaign_id, recipient_id, url, clicked_at) VALUES ($1, $2, $3, $4, $5, NOW())`, [randomUUID(), rec.user_id, rec.campaign_id, rec.id, url.slice(0, 4096)]).catch(() => undefined);
  if (!rec.clicked_at) {
    const first = await queryOne<{ id: string }>(`UPDATE campaign_recipients SET clicked_at = NOW(), opened_at = COALESCE(opened_at, NOW()) WHERE id = $1 AND clicked_at IS NULL RETURNING id`, [rec.id]).catch(() => null);
    if (first) {
      await query(`UPDATE campaigns SET clicked_count = clicked_count + 1, opened_count = opened_count + CASE WHEN $2 THEN 1 ELSE 0 END, updated_at = NOW() WHERE id = $1`, [rec.campaign_id, !rec.opened_at]).catch(() => undefined);
    }
  }
  // Only the first click per recipient fans out (webhooks/automations); replays just log the row.
  if (!rec.clicked_at) await emitEvent(rec.user_id, { type: "campaign.recipient_clicked", entity: "campaign", entityId: rec.campaign_id, data: { recipient_id: rec.id, url: url.slice(0, 500) } });
  return true;
}

export interface UnsubscribeTarget {
  dataId: string;
  contactId: string;
  recipientId: string | null;
  campaignId: string | null;
  channel: MarketingSendChannel;
}

export async function resolveUnsubscribeRecipient(recipientId: string): Promise<UnsubscribeTarget | null> {
  const row = await queryOne<{ user_id: string; contact_id: string; campaign_id: string; channel: MarketingSendChannel }>(
    `SELECT r.user_id, r.contact_id, r.campaign_id, c.channel FROM campaign_recipients r JOIN campaigns c ON c.id = r.campaign_id WHERE r.id = $1`,
    [recipientId]
  ).catch(() => null);
  return row ? { dataId: row.user_id, contactId: row.contact_id, recipientId, campaignId: row.campaign_id, channel: row.channel } : null;
}

/**
 * One-click withdrawal: appends a `withdrawn` consent row for the channel
 * (both marketing purposes when `all`), marks the recipient unsubscribed and
 * emits `contact.unsubscribed`. Idempotent.
 */
export async function unsubscribe(target: UnsubscribeTarget, opts: { all?: boolean; ip?: string | null; ua?: string | null } = {}): Promise<{ withdrawn: string[] }> {
  const purposes = opts.all ? (["marketing_email", "marketing_sms"] as const) : ([CONSENT_PURPOSE_FOR_CHANNEL[target.channel]] as const);
  const subject = { kind: "contact", id: target.contactId } as const;
  const current = await currentConsent(target.dataId, subject);
  const withdrawn: string[] = [];
  let changed = false;
  for (const purpose of purposes) {
    // Idempotent: a replayed one-click POST appends nothing when already withdrawn.
    if (current[purpose]?.status !== "withdrawn") {
      // Errors propagate: the route must never report success when the ledger write failed.
      await recordConsent(target.dataId, subject, purpose, "withdrawn", "form", { ip: opts.ip ?? null, ua: opts.ua ?? null, text: target.campaignId ? `unsubscribe link (campaign ${target.campaignId})` : "unsubscribe link" });
      changed = true;
    }
    withdrawn.push(purpose);
  }
  // Suppress the address too, so a duplicate/re-imported contact with the same email or phone is also blocked (canSendMarketing matches opt-outs by address).
  const contact = await queryOne<{ email: string | null; phone: string | null }>(`SELECT email, phone FROM crm_contacts WHERE user_id = $1 AND id = $2`, [target.dataId, target.contactId]);
  const optChannel = opts.all ? "all" : target.channel;
  const existingOptout = await queryOne<{ id: string }>(`SELECT id FROM contact_optouts WHERE user_id = $1 AND contact_id = $2 AND channel IN ($3, 'all') LIMIT 1`, [target.dataId, target.contactId, optChannel]);
  if (!existingOptout) {
    await query(`INSERT INTO contact_optouts (user_id, contact_id, phone, email, channel, reason, created_at) VALUES ($1, $2, $3, $4, $5, 'unsubscribe link', NOW())`, [
      target.dataId,
      target.contactId,
      optChannel === "email" ? null : (contact?.phone ?? null),
      optChannel === "sms" ? null : (contact?.email?.toLowerCase() ?? null),
      optChannel,
    ]);
    changed = true;
  }
  if (target.recipientId) {
    const r = await queryOne<{ id: string }>(`UPDATE campaign_recipients SET status = 'unsubscribed' WHERE id = $1 AND status <> 'unsubscribed' RETURNING id`, [target.recipientId]).catch(() => null);
    if (r && target.campaignId) await query(`UPDATE campaigns SET unsubscribed_count = unsubscribed_count + 1, updated_at = NOW() WHERE id = $1`, [target.campaignId]).catch(() => undefined);
  }
  // Exit any active sequence enrollments for this contact.
  await query(`UPDATE sequence_enrollments SET status = 'exited', exited_reason = 'unsubscribed', updated_at = NOW() WHERE user_id = $1 AND contact_id = $2 AND status = 'active'`, [target.dataId, target.contactId]).catch(() => undefined);
  if (changed) await emitEvent(target.dataId, { type: "contact.unsubscribed", entity: "contact", entityId: target.contactId, data: { campaign_id: target.campaignId, channel: target.channel, purposes: withdrawn } });
  return { withdrawn };
}

/* ---------- analytics ---------- */

export async function campaignStats(dataId: string, campaignId: string): Promise<CampaignStats> {
  const rows = await query<{ status: RecipientStatus; n: string; opened: string; clicked: string }>(
    `SELECT status, COUNT(*)::text AS n, SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END)::text AS opened, SUM(CASE WHEN clicked_at IS NOT NULL THEN 1 ELSE 0 END)::text AS clicked
       FROM campaign_recipients WHERE user_id = $1 AND campaign_id = $2 GROUP BY status`,
    [dataId, campaignId]
  );
  const byStatus: Partial<Record<RecipientStatus, number>> = {};
  let opened = 0;
  let clicked = 0;
  for (const r of rows) {
    byStatus[r.status] = parseInt(r.n, 10) || 0;
    opened += parseInt(r.opened, 10) || 0;
    clicked += parseInt(r.clicked, 10) || 0;
  }
  return computeCampaignStats(byStatus, opened, clicked);
}

export async function statsForCampaigns(dataId: string, ids: string[]): Promise<Map<string, CampaignStats>> {
  const out = new Map<string, CampaignStats>();
  if (ids.length === 0) return out;
  const rows = await query<{ campaign_id: string; status: RecipientStatus; n: string; opened: string; clicked: string }>(
    `SELECT campaign_id, status, COUNT(*)::text AS n, SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END)::text AS opened, SUM(CASE WHEN clicked_at IS NOT NULL THEN 1 ELSE 0 END)::text AS clicked
       FROM campaign_recipients WHERE user_id = $1 AND campaign_id = ANY($2) GROUP BY campaign_id, status`,
    [dataId, ids]
  ).catch(() => []);
  const acc = new Map<string, { by: Partial<Record<RecipientStatus, number>>; opened: number; clicked: number }>();
  for (const r of rows) {
    const a = acc.get(r.campaign_id) ?? { by: {}, opened: 0, clicked: 0 };
    a.by[r.status] = parseInt(r.n, 10) || 0;
    a.opened += parseInt(r.opened, 10) || 0;
    a.clicked += parseInt(r.clicked, 10) || 0;
    acc.set(r.campaign_id, a);
  }
  for (const id of ids) {
    const a = acc.get(id);
    out.set(id, a ? computeCampaignStats(a.by, a.opened, a.clicked) : computeCampaignStats({}, 0, 0));
  }
  return out;
}

export async function topLinks(dataId: string, campaignId: string, limit = 10): Promise<Array<{ url: string; clicks: number; unique: number }>> {
  const rows = await query<{ url: string; clicks: string; uniq: string }>(
    `SELECT url, COUNT(*)::text AS clicks, COUNT(DISTINCT recipient_id)::text AS uniq FROM link_clicks WHERE user_id = $1 AND campaign_id = $2 GROUP BY url ORDER BY COUNT(*) DESC LIMIT $3`,
    [dataId, campaignId, Math.max(1, Math.min(50, limit))]
  ).catch(() => []);
  return rows.map((r) => ({ url: r.url, clicks: parseInt(r.clicks, 10) || 0, unique: parseInt(r.uniq, 10) || 0 }));
}

export interface RecipientWithContact extends RecipientRow {
  full_name: string | null;
}

export async function listRecipients(dataId: string, campaignId: string, opts: { status?: RecipientStatus | null; limit?: number; cursor?: Cursor | null } = {}): Promise<RecipientWithContact[]> {
  const params: unknown[] = [dataId, campaignId];
  const where = ["r.user_id = $1", "r.campaign_id = $2"];
  if (opts.status) {
    params.push(opts.status);
    where.push(`r.status = $${params.length}`);
  }
  const keyset = keysetClause(opts.cursor, params, { alias: "r." });
  params.push(Math.max(1, Math.min(201, opts.limit ?? 50)));
  return query<RecipientWithContact>(
    `SELECT ${RECIPIENT_COLS.split(", ").map((c) => `r.${c}`).join(", ")}, c.full_name FROM campaign_recipients r LEFT JOIN crm_contacts c ON c.id = r.contact_id
      WHERE ${where.join(" AND ")}${keyset} ORDER BY ${keysetOrder("r.")} LIMIT $${params.length}`,
    params
  );
}

/** Send the campaign content to one address (the operator) without touching recipients or consent. */
export async function testSend(dataId: string, campaignId: string, to: string): Promise<{ outboxId: string }> {
  const campaign = await getCampaign(dataId, campaignId);
  if (!campaign) throw new CampaignError("Campaign not found", "not_found");
  if (!campaign.body_md.trim()) throw new CampaignError("Add content before sending a test", "no_content");
  const sample: AudienceContact = { id: "test", full_name: "Test Recipient", email: to, phone: to, company: "Sample Co", lifecycle: "lead" };
  const outcome = await sendMarketingMessage(dataId, {
    channel: campaign.channel,
    contact: sample,
    subject: campaign.subject ? `[Test] ${campaign.subject}` : "[Test]",
    preheader: campaign.preheader,
    body_md: campaign.body_md,
    from_name: campaign.from_name,
    reply_to: campaign.reply_to,
    campaignId: campaign.id,
    skipConsent: true,
    to,
  });
  if (!outcome.ok) throw new CampaignError(`Test send was not queued (${outcome.reason})`, "invalid_state");
  return { outboxId: outcome.outboxId };
}
