import { buildTimeline, type TimelineData } from "./pure";
import { listMilestones, listProjectTasks, requireProject } from "./store";

/** Milestones (diamonds) + tasks (bars by start/due) for the Gantt-lite view. */
export async function timelineData(dataId: string, id: string, now = new Date()): Promise<TimelineData> {
  const project = await requireProject(dataId, id);
  const [tasks, milestones] = await Promise.all([listProjectTasks(dataId, id, { limit: 1000 }), listMilestones(dataId, id)]);
  return buildTimeline({ id: project.id, name: project.name, starts_on: project.starts_on, due_on: project.due_on }, milestones, tasks, now);
}
