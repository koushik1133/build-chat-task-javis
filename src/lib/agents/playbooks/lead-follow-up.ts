import { query, queryOne } from "@/lib/dsql";
import type { PlaybookDef } from "./types";

type Lead = {
  id: string; data: string; research_summary: string | null;
  draft_email_subject: string | null; draft_email_body: string | null;
  status: string | null; enriched_at: string | null; created_at: string;
};

/**
 * site_leads with an AI draft ready ('draft_ready') that nobody sent for 24h.
 * Columns: status, sent_at, enriched_at, draft_email_* (aws/migrations.sql).
 * enriched_at is when the draft became ready; falls back to created_at.
 */
export const leadFollowUp: PlaybookDef = {
  id: "lead-follow-up",
  name: "Lead draft not sent",
  description: "Finds captured leads whose follow-up email draft has sat unsent for 24+ hours and gets it out the door.",
  eventTypes: ["lead.enriched"],
  cooldownHours: 48,
  defaultTools: ["leads.get", "comms.send_email"],
  async detect(userId) {
    const rows = await query<{ id: string }>(
      `SELECT id FROM site_leads
       WHERE user_id = $1 AND status = 'draft_ready' AND sent_at IS NULL
         AND COALESCE(enriched_at, created_at) < NOW() - INTERVAL '24 hours'
       ORDER BY created_at ASC LIMIT 25`,
      [userId]
    ).catch(() => []);
    return rows.map((r) => r.id);
  },
  async buildPrompt(userId, entityId) {
    const l = await queryOne<Lead>(
      `SELECT id, data, research_summary, draft_email_subject, draft_email_body, status, enriched_at, created_at
       FROM site_leads WHERE id = $1 AND user_id = $2`,
      [entityId, userId]
    ).catch(() => null);
    if (!l) return `Lead ${entityId} no longer exists; do nothing and finish.`;
    return [
      `Lead ${l.id} captured ${l.created_at} has a ready follow-up draft that was never sent.`,
      `Form data: ${l.data.slice(0, 600)}`,
      l.research_summary ? `Research: ${l.research_summary.slice(0, 600)}` : "",
      `Draft subject: ${l.draft_email_subject ?? "(none)"}`,
      `Draft body:\n${(l.draft_email_body ?? "(none)").slice(0, 1200)}`,
      "",
      "1. Load the lead with leads.get and sanity-check the draft is still accurate and appropriate.",
      "2. Tighten the draft if needed, then send it with comms.send_email (this will pause for approval).",
    ].filter(Boolean).join("\n");
  },
};
