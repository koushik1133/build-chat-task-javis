import { queryOne } from "@/lib/dsql";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { businessName } from "@/lib/money/quotes";
import { createPayLink } from "@/lib/money/invoices";
import { logger } from "@/lib/log/logger";

/** Transactional messages to a member (consent-free: they relate to a service the customer bought). */

export async function contactEmail(dataId: string, contactId: string): Promise<{ name: string | null; email: string | null }> {
  const r = await queryOne<{ full_name: string | null; email: string | null }>(`SELECT full_name, email FROM crm_contacts WHERE id = $1 AND user_id = $2`, [contactId, dataId]).catch(() => null);
  return { name: r?.full_name ?? null, email: r?.email?.trim() || null };
}

export async function notifyMember(
  dataId: string,
  contactId: string,
  msg: { kind: string; subject: string; body: string; subscriptionId: string; extra?: Record<string, unknown> }
): Promise<boolean> {
  try {
    const c = await contactEmail(dataId, contactId);
    if (!c.email) return false;
    const from = await businessName(dataId);
    await enqueueNotification(dataId, {
      channel: "email",
      recipient: c.email,
      subject: msg.subject,
      body: `Hello${c.name ? ` ${c.name}` : ""},\n\n${msg.body}\n\n${from}`,
      data: { kind: msg.kind, category: "billing", subscription_id: msg.subscriptionId, ...msg.extra },
    });
    return true;
  } catch (err) {
    logger.warn("membership notification failed", { kind: msg.kind, err: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** Fresh pay link for an invoice, or null when it cannot be paid (already paid / void). */
export async function payUrlFor(dataId: string, invoiceId: string | null): Promise<string | null> {
  if (!invoiceId) return null;
  try {
    return (await createPayLink(dataId, invoiceId)).url;
  } catch {
    return null;
  }
}
