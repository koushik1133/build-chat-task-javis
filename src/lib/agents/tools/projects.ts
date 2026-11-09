import { z } from "zod";
import { registerTool } from "@/lib/agents/registry";
import type { ToolResult } from "@/lib/agents/types";
import { projectBudget } from "@/lib/projects/budget";
import { projectProgress } from "@/lib/projects/progress";
import { PROJECT_STATUSES, ProjectError, TASK_PRIORITIES, type ProjectStatus } from "@/lib/projects/pure";
import { createProjectTask, getProject, listMilestones, listProjects } from "@/lib/projects/store";

/** Projects tools: list (read), status with progress + budget (read), create task (write, approval). Scoped to ctx.userId (org data id). */

function fail(error: string): ToolResult {
  return { ok: false, summary: error, error };
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function resolveProject(dataId: string, ref: string) {
  const byId = await getProject(dataId, ref);
  if (byId) return byId;
  const all = await listProjects(dataId, { limit: 200 });
  const needle = ref.trim().toLowerCase();
  return all.find((p) => p.code?.toLowerCase() === needle) ?? all.find((p) => p.name.toLowerCase() === needle) ?? all.find((p) => p.name.toLowerCase().includes(needle)) ?? null;
}

/* ---------- projects.list ---------- */
const ListInput = z.object({ status: z.enum(PROJECT_STATUSES).optional(), q: z.string().max(120).optional(), limit: z.number().int().min(1).max(50).optional() });
type ListInputT = z.infer<typeof ListInput>;

registerTool<ListInputT>({
  name: "projects.list",
  module: "projects",
  description: "List projects (active and planning by default) with status, dates, budget and owner. Filter by status or search by name/code.",
  input: ListInput,
  parameters: {
    type: "object",
    properties: {
      status: { type: "string", enum: [...PROJECT_STATUSES], description: "Only this status (optional)" },
      q: { type: "string", description: "Search in name or code (optional)" },
      limit: { type: "number", description: "Max rows (default 20)" },
    },
  },
  scope: "read",
  preview: (i) => `List ${i.status ?? "all"} projects${i.q ? ` matching "${i.q}"` : ""}`,
  async run(ctx, input) {
    try {
      const rows = await listProjects(ctx.userId, { status: (input.status as ProjectStatus | undefined) ?? null, q: input.q ?? null, limit: input.limit ?? 20 });
      return {
        ok: true,
        summary: `${rows.length} project${rows.length === 1 ? "" : "s"}`,
        data: rows.map((p) => ({ id: p.id, name: p.name, code: p.code, status: p.status, starts_on: p.starts_on, due_on: p.due_on, budget_minor: p.budget_minor, currency: p.currency, contact_name: p.contact_name, owner_member_id: p.owner_member_id })),
      };
    } catch (err) {
      return fail(`List failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- projects.status ---------- */
const StatusInput = z.object({ project: z.string().min(1).max(200).describe("Project id, code or name") });
type StatusInputT = z.infer<typeof StatusInput>;

registerTool<StatusInputT>({
  name: "projects.status",
  module: "projects",
  description: "Progress (tasks done/total, overdue, days remaining), milestones and budget vs actual for one project. Use before summarising or answering 'how is X going'.",
  input: StatusInput,
  parameters: { type: "object", properties: { project: { type: "string", description: "Project id, code or name" } }, required: ["project"] },
  scope: "read",
  preview: (i) => `Project status for ${i.project}`,
  async run(ctx, input) {
    try {
      const project = await resolveProject(ctx.userId, input.project);
      if (!project) return fail(`No project matches "${input.project}"`);
      const [progress, budget, milestones] = await Promise.all([projectProgress(ctx.userId, project.id), projectBudget(ctx.userId, project), listMilestones(ctx.userId, project.id)]);
      const burn = budget.burn_pct === null ? "no budget" : `${budget.burn_pct}% of budget used`;
      return {
        ok: true,
        summary: `${project.name}: ${progress.percent}% of tasks done (${progress.tasks_done}/${progress.tasks_total}), ${progress.overdue_tasks} overdue, ${burn}`,
        data: { project, progress, budget, milestones },
      };
    } catch (err) {
      return fail(`Status failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- projects.create_task ---------- */
const CreateTaskInput = z.object({
  project: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  assignee_id: z.string().max(100).optional(),
  due_at: z.string().max(40).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  estimate_minutes: z.number().int().min(0).max(100_000).optional(),
  milestone: z.string().max(200).optional(),
});
type CreateTaskInputT = z.infer<typeof CreateTaskInput>;

registerTool<CreateTaskInputT>({
  name: "projects.create_task",
  module: "projects",
  description: "Add a task to a project with optional assignee (member user id), ISO due date, priority, estimate and milestone (id or name). Requires approval.",
  input: CreateTaskInput,
  parameters: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project id, code or name" },
      title: { type: "string" },
      assignee_id: { type: "string", description: "Member user id (optional)" },
      due_at: { type: "string", description: "ISO date or datetime (optional)" },
      priority: { type: "string", enum: [...TASK_PRIORITIES] },
      estimate_minutes: { type: "number" },
      milestone: { type: "string", description: "Milestone id or name (optional)" },
    },
    required: ["project", "title"],
  },
  scope: "write",
  requiresApproval: true,
  preview: (i) => `Create task "${i.title}" in ${i.project}${i.due_at ? ` due ${i.due_at}` : ""}`,
  async run(ctx, input) {
    try {
      const project = await resolveProject(ctx.userId, input.project);
      if (!project) return fail(`No project matches "${input.project}"`);
      let milestone_id: string | null = null;
      if (input.milestone) {
        const ms = await listMilestones(ctx.userId, project.id);
        const needle = input.milestone.trim().toLowerCase();
        milestone_id = ms.find((m) => m.id === input.milestone)?.id ?? ms.find((m) => m.name.toLowerCase() === needle)?.id ?? null;
        if (!milestone_id) return fail(`No milestone "${input.milestone}" in ${project.name}`);
      }
      let due_at: string | null = null;
      if (input.due_at) {
        const d = new Date(input.due_at.length === 10 ? `${input.due_at}T17:00:00Z` : input.due_at);
        if (Number.isNaN(d.getTime())) return fail("due_at must be an ISO date");
        due_at = d.toISOString();
      }
      const task = await createProjectTask(ctx.userId, project.id, { title: input.title.trim(), assignee_id: input.assignee_id ?? null, due_at, priority: input.priority ?? null, estimate_minutes: input.estimate_minutes ?? null, milestone_id }, { source: "tool" });
      return { ok: true, summary: `Created "${task.title}" in ${project.name}`, data: { task, project: { id: project.id, name: project.name } } };
    } catch (err) {
      if (err instanceof ProjectError) return fail(err.message);
      return fail(`Create failed: ${errMsg(err)}`);
    }
  },
});
