import { computeProgress, type ProjectProgress } from "./pure";
import { listMilestones, listProjectTasks, requireProject } from "./store";

/** Tasks done/total, milestone status, overdue tasks and days remaining for one project. */
export async function projectProgress(dataId: string, id: string, now = new Date()): Promise<ProjectProgress> {
  const project = await requireProject(dataId, id);
  const [tasks, milestones] = await Promise.all([listProjectTasks(dataId, id, { limit: 1000 }), listMilestones(dataId, id)]);
  return computeProgress(tasks, milestones, project, now);
}
