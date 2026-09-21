import { query, queryOne } from "@/lib/dsql";
import type { PlaybookDef } from "./types";

type Contact = {
  id: string; full_name: string; email: string | null; company: string | null;
  lifecycle: string; notes: string | null; last_contact: string | null;
  deal_value: string | null; created_at: string;
};

/**
 * crm_contacts still in lead/prospect with no touch in 7 days.
 * Columns used: lifecycle, last_contact, created_at (all in aws/migrations.sql).
 */
export const stalledDeal: PlaybookDef = {
  id: "stalled-deal",
  name: "Stalled deal follow-up",
  description: "Finds leads and prospects nobody has contacted in 7+ days, researches them and drafts a follow-up email.",
  eventTypes: ["crm.contact.stage_changed"],
  cooldownHours: 72,
  defaultTools: ["crm.get_contact", "crm.log_activity", "comms.draft_email", "comms.send_email"],
  async detect(userId) {
    const rows = await query<{ id: string }>(
      `SELECT id FROM crm_contacts
       WHERE user_id = $1
         AND lifecycle IN ('lead','prospect')
         AND (last_contact IS NULL OR last_contact < NOW() - INTERVAL '7 days')
         AND created_at < NOW() - INTERVAL '7 days'
       ORDER BY deal_value DESC NULLS LAST, created_at ASC
       LIMIT 20`,
      [userId]
    ).catch(() => []);
    return rows.map((r) => r.id);
  },
  async buildPrompt(userId, entityId) {
    const c = await queryOne<Contact>(
      `SELECT id, full_name, email, company, lifecycle, notes, last_contact, deal_value, created_at
       FROM crm_contacts WHERE id = $1 AND user_id = $2`,
      [entityId, userId]
    ).catch(() => null);
    if (!c) return `Contact ${entityId} no longer exists; do nothing and finish.`;
    return [
      `A deal looks stalled. Contact id: ${c.id}.`,
      `Name: ${c.full_name}${c.company ? ` (${c.company})` : ""}. Stage: ${c.lifecycle}. Deal value: ${c.deal_value ?? "unknown"}.`,
      `Last contact: ${c.last_contact ?? "never"}. In CRM since ${c.created_at}.`,
      c.notes ? `Notes: ${c.notes.slice(0, 800)}` : "",
      "",
      "1. Use crm.get_contact to load the full record and any recent activity.",
      "2. Research what has changed for this contact or their company that would make a follow-up timely.",
      "3. Draft a short, specific follow-up email with comms.draft_email (subject + body, under 150 words).",
      "4. Log what you did with crm.log_activity. Only call comms.send_email if it has been approved.",
    ].filter(Boolean).join("\n");
  },
};
