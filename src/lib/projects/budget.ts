import { query, queryOne } from "@/lib/dsql";
import { timeValueMinor } from "@/lib/finance/time";
import { jobCosting, jobKey } from "@/lib/finance/job-costing";
import { tableExists } from "@/lib/table-exists";
import { computeBudget, type ProjectBudget, type ProjectDTO } from "./pure";
import { requireProject } from "./store";

/**
 * Budget vs actual for a project. Actuals = logged time at the entry's rate
 * (falling back to the project's hourly rate), expenses incl. tax, and stock
 * consumed against ref_kind='project'. Billed/paid come from invoices raised
 * from the project's quote.
 */
export async function projectBudget(dataId: string, idOrProject: string | ProjectDTO): Promise<ProjectBudget> {
  const project = typeof idOrProject === "string" ? await requireProject(dataId, idOrProject) : idOrProject;
  const id = project.id;

  const [time, expenses, stock, billed] = await Promise.all([
    query<{ minutes: number | string | null; rate_minor: number | string }>(
      `SELECT minutes, rate_minor FROM time_entries WHERE user_id = $1 AND ended_at IS NOT NULL AND (project_id = $2 OR (ref_kind = 'project' AND ref_id = $2))`,
      [dataId, id]
    ),
    queryOne<{ total: string | number | null }>(
      `SELECT COALESCE(SUM(amount_minor + tax_minor), 0) AS total FROM expenses WHERE user_id = $1 AND (project_id = $2 OR (ref_kind = 'project' AND ref_id = $2))`,
      [dataId, id]
    ),
    (async () => {
      if (!(await tableExists("stock_movements"))) return 0;
      const report = await jobCosting(dataId, { refKind: "project", refId: id }).catch(() => null);
      const job = report?.jobs.find((j) => j.key === jobKey("project", id));
      return job?.stock_minor ?? 0;
    })(),
    project.quote_id
      ? queryOne<{ billed: string | number | null; paid: string | number | null }>(
          `SELECT COALESCE(SUM(total_minor), 0) AS billed, COALESCE(SUM(paid_minor), 0) AS paid FROM invoices WHERE user_id = $1 AND quote_id = $2 AND status <> 'void'`,
          [dataId, project.quote_id]
        )
      : Promise.resolve(null),
  ]);

  let minutes = 0;
  let timeMinor = 0;
  for (const t of time) {
    const m = Number(t.minutes) || 0;
    minutes += m;
    const rate = Number(t.rate_minor) || project.hourly_rate_minor || 0;
    timeMinor += timeValueMinor(m, rate);
  }
  return computeBudget({
    budget_minor: project.budget_minor,
    currency: project.currency,
    time_minutes: minutes,
    time_minor: timeMinor,
    expense_minor: Number(expenses?.total) || 0,
    stock_minor: stock,
    billed_minor: Number(billed?.billed) || 0,
    paid_minor: Number(billed?.paid) || 0,
  });
}
