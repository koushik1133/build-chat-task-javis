import { getQuote } from "@/lib/money/quotes";
import { query } from "@/lib/dsql";
import { getRecord } from "@/lib/records/store";
import { mapQuoteToProject, ProjectError, ymd, type FromQuoteInput, type MilestoneDTO, type ProjectDTO, type ProjectStatus } from "./pure";
import { createMilestone, createProject, getProject } from "./store";

/** Quote → project (budget = quote total, currency, contact) with optional milestones from the line items. */
export async function createProjectFromQuote(dataId: string, input: FromQuoteInput, actorId?: string | null): Promise<{ project: ProjectDTO; milestones: MilestoneDTO[] }> {
  const quote = await getQuote(dataId, input.quoteId);
  if (!quote) throw new ProjectError("Quote not found", 404);
  const mapped = mapQuoteToProject(
    { id: quote.id, number: quote.number, contact_id: quote.contact_id, contact_name: quote.contact_name, currency: quote.currency, total_minor: quote.total_minor, items: quote.items },
    { name: input.name, milestonesFromItems: input.milestonesFromItems, starts_on: input.starts_on, due_on: input.due_on }
  );
  const project = await createProject(dataId, mapped.project, actorId);
  const milestones: MilestoneDTO[] = [];
  for (const m of mapped.milestones) milestones.push(await createMilestone(dataId, project.id, m));
  return { project, milestones };
}

const STAGE_TO_STATUS: Record<string, ProjectStatus> = { backlog: "planning", planned: "planning", in_progress: "active", review: "active", done: "done" };

/**
 * Records "projects" pack → first-class project. Copies title, client, budget,
 * due date and description, then stamps the record with `project_id` so the
 * action is idempotent.
 */
export async function convertRecordToProject(dataId: string, recordId: string, actorId?: string | null): Promise<{ project: ProjectDTO; alreadyConverted: boolean }> {
  const record = await getRecord(dataId, recordId);
  if (!record || record.deleted_at) throw new ProjectError("Record not found", 404);
  const existing = typeof record.data.project_id === "string" ? record.data.project_id : null;
  if (existing) {
    const p = await getProject(dataId, existing);
    if (p) return { project: p, alreadyConverted: true };
  }
  const d = record.data;
  const dueRaw = typeof d.due_on === "string" ? d.due_on : record.due_at;
  const budget = typeof d.budget === "number" ? d.budget : record.amount_minor ?? 0;
  const project = await createProject(
    dataId,
    {
      name: record.title,
      code: null,
      description_md: typeof d.description === "string" ? d.description : record.summary,
      contact_id: record.contact_id,
      quote_id: null,
      status: STAGE_TO_STATUS[record.stage] ?? "planning",
      starts_on: null,
      due_on: dueRaw ? ymd(String(dueRaw)) : null,
      budget_minor: Math.max(0, Math.round(Number(budget) || 0)),
      currency: record.currency ?? "USD",
      billing_mode: "none",
      hourly_rate_minor: 0,
      owner_member_id: record.assigned_to ?? actorId ?? null,
      color: null,
    },
    actorId
  );
  // Stamp the record directly: `project_id` is not a declared field, so the validated updater would drop it.
  await query(`UPDATE records SET data = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2`, [record.id, dataId, JSON.stringify({ ...d, project_id: project.id })]).catch(() => undefined);
  return { project, alreadyConverted: false };
}
