import type { MilestoneDTO, ProjectBudget, ProjectDTO, ProjectMemberDTO, ProjectProgress } from "@/lib/projects/pure";

export interface ProjectDetail {
  project: ProjectDTO;
  progress: ProjectProgress;
  budget: ProjectBudget;
  milestones: MilestoneDTO[];
  members: ProjectMemberDTO[];
}

export type Notice = { tone: "success" | "error"; text: string };
