import { query, queryOne } from "@/lib/dsql";
import { complete } from "@/lib/llm";

export interface EnrichmentResult {
  research: string;
  subject: string;
  body: string;
}

/**
 * Research a captured lead and draft a personalised outreach email.
 *
 * Callable directly from server code (lead-capture routes) so the work never
 * has to round-trip through an HTTP endpoint — that older approach both
 * required a publicly reachable enrichment route and derived its target URL
 * from a caller-controlled `Origin` header.
 *
 * Returns `null` when the lead does not exist for that owner, so callers can
 * distinguish "not found" from a genuine failure.
 */
export async function enrichLead(
  leadId: string,
  userId: string
): Promise<EnrichmentResult | null> {
  const lead = await queryOne<{ data: string }>(
    `SELECT data FROM site_leads WHERE id = $1 AND user_id = $2`,
    [leadId, userId]
  );
  if (!lead) return null;

  let leadData: unknown;
  try {
    leadData = JSON.parse(lead.data);
  } catch {
    // Stored payload is malformed — fall back to the raw text so enrichment
    // still produces something useful rather than throwing.
    leadData = lead.data;
  }

  const serialised = JSON.stringify(leadData).slice(0, 4000);

  const research = await complete(
    [
      {
        role: "user",
        content: `Given this lead info: ${serialised}, research and summarize: company overview, likely pain points, and why they'd be interested in an AI business platform. Be concise (100 words).`,
      },
    ],
    { maxTokens: 300 }
  );

  const outreachRaw = await complete(
    [
      {
        role: "user",
        content: `Given this lead: ${serialised} and research: ${research}, write a personalized cold email.
Format your response exactly like this:
Subject: [Your Subject Here]
Body:
[Your Body Here]

Keep the body under 100 words. Professional, specific, not generic.`,
      },
    ],
    { maxTokens: 400 }
  );

  let subject = "Quick question";
  let body = outreachRaw;

  const subjectMatch = outreachRaw.match(/^Subject:\s*(.*)/im);
  if (subjectMatch) {
    subject = subjectMatch[1].trim();
    body = outreachRaw
      .replace(/^Subject:\s*.*(\r\n|\n)/im, "")
      .replace(/^Body:\s*(\r\n|\n)?/im, "")
      .trim();
  }

  await query(
    `UPDATE site_leads
     SET research_summary = $1, draft_email_subject = $2, draft_email_body = $3,
         status = 'draft_ready', enriched_at = NOW()
     WHERE id = $4 AND user_id = $5`,
    [research, subject, body, leadId, userId]
  );

  return { research, subject, body };
}
