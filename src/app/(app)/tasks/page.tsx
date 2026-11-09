import { Suspense } from "react";
import { TaskList } from "@/components/task-list";
import { PageContainer } from "@/components/page-container";
import { MyTasksPanel } from "@/components/projects/my-tasks";
import { TasksViewSwitch } from "@/components/projects/tasks-view-switch";

/** /tasks?mine=1 shows "My tasks" (assigned to me across projects) above the personal list. */
export default async function TasksPage({ searchParams }: { searchParams: Promise<{ mine?: string }> }) {
  const sp = await searchParams;
  const mine = sp.mine === "1";
  return (
    <PageContainer
      title="Tasks"
      description="Auto-extracted from your chats — and you can add your own."
      tooltip="Your personal to-do list. AI agents and automations can also create tasks here for your review. Switch to My tasks for work assigned to you inside projects."
      actions={
        <Suspense fallback={null}>
          <TasksViewSwitch mine={mine} />
        </Suspense>
      }
    >
      {mine && <MyTasksPanel className="mb-6" />}
      <TaskList />
    </PageContainer>
  );
}
