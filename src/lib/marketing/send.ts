import { queryOne } from "@/lib/dsql";
import { getBranding } from "@/lib/branding";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { canSendMarketing, type MarketingDecision } from "@/lib/privacy/consent";
import { firstNameOf, renderEmail, renderSms, rewriteLinks, type MergeVars } from "./render";
import { clickUrl, openPixelUrl, unsubscribeContactUrl, unsubscribeOneClickUrl, unsubscribeUrl } from "./tracking";
import type { MarketingSendChannel } from "./types";

/**
 * The one path every marketing message takes: consent gate → merge render →
 * tracking links → outbox row tagged `category: "marketing"`. Campaigns and
 * sequences both call `sendMarketingMessage`; nothing else enqueues marketing.
 */

export interface MarketingContact {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
}

export async function loadContact(dataId: string, contactId: string): Promise<MarketingContact | null> {
  return queryOne<MarketingContact>(`SELECT id, full_name, email, phone, company FROM crm_contacts WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL`, [dataId, contactId]);
}

/** Brand name when branding is configured, else the organization's name. */
async function orgDisplayName(dataId: string): Promise<string> {
  const branding = await getBranding(dataId).catch(() => null);
  if (branding?.configured && branding.brand_name) return branding.brand_name;
  const org = await queryOne<{ name: string }>(`SELECT name FROM organizations WHERE owner_user_id = $1 ORDER BY created_at ASC LIMIT 1`, [dataId]).catch(() => null);
  return org?.name ?? branding?.brand_name ?? "";
}

export async function mergeVarsFor(dataId: string, contact: MarketingContact, unsubscribe: string): Promise<MergeVars> {
  const orgName = await orgDisplayName(dataId);
  return {
    first_name: firstNameOf(contact.full_name),
    full_name: contact.full_name,
    company: contact.company ?? "",
    email: contact.email ?? "",
    org_name: orgName,
    unsubscribe_url: unsubscribe,
  };
}

export interface SendInput {
  channel: MarketingSendChannel;
  contact: MarketingContact;
  subject?: string | null;
  preheader?: string | null;
  body_md: string;
  from_name?: string | null;
  reply_to?: string | null;
  /** Campaign recipient row (enables open/click tracking and per-recipient unsubscribe). */
  recipientId?: string | null;
  campaignId?: string | null;
  sequenceId?: string | null;
  /** Skip the consent gate (test sends to the operator only). */
  skipConsent?: boolean;
  /** Override the destination (test sends). */
  to?: string | null;
}

export type SendOutcome = { ok: true; outboxId: string } | { ok: false; reason: MarketingDecision["reason"] | "no_address" | "skipped_by_preferences" };

export async function sendMarketingMessage(dataId: string, input: SendInput): Promise<SendOutcome> {
  if (!input.skipConsent) {
    const decision = await canSendMarketing(dataId, input.contact.id, input.channel);
    if (!decision.allowed) return { ok: false, reason: decision.reason };
  }
  const to = (input.to ?? (input.channel === "email" ? input.contact.email : input.contact.phone))?.trim();
  if (!to) return { ok: false, reason: "no_address" };

  const unsubscribe = input.recipientId ? unsubscribeUrl(input.recipientId) : unsubscribeContactUrl(dataId, input.contact.id, input.channel);
  const vars = await mergeVarsFor(dataId, input.contact, unsubscribe);
  const data: Record<string, unknown> = { category: "marketing", campaign_id: input.campaignId ?? null, recipient_id: input.recipientId ?? null, sequence_id: input.sequenceId ?? null, contact_id: input.contact.id };

  let outboxId: string;
  if (input.channel === "email") {
    const rendered = renderEmail({ subject: input.subject ?? "", preheader: input.preheader, body_md: input.body_md, vars, pixelUrl: input.recipientId ? openPixelUrl(input.recipientId) : null });
    const rid = input.recipientId;
    const html = rid ? rewriteLinks(rendered.html, (url) => (url.startsWith(unsubscribe) || url.includes("/api/t/") ? null : clickUrl(rid, url))) : rendered.html;
    if (input.from_name) data.fromName = input.from_name;
    data.headers = { "List-Unsubscribe": `<${unsubscribeOneClickUrl(unsubscribe)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
    if (input.reply_to) data.replyTo = input.reply_to;
    outboxId = await enqueueNotification(dataId, { channel: "email", recipient: to, subject: rendered.subject || "(no subject)", body: html, data });
  } else {
    const text = renderSms(input.body_md, vars);
    outboxId = await enqueueNotification(dataId, { channel: "sms", recipient: to, subject: null, body: text, data });
  }
  if (outboxId.startsWith("skipped:")) return { ok: false, reason: "skipped_by_preferences" };
  return { ok: true, outboxId };
}
