import { TaskList } from "@/components/task-list";
import { PageContainer } from "@/components/page-container";

export default function TasksPage() {
  return (
    <PageContainer
      title="Tasks"
      description="Auto-extracted from your chats — and you can add your own."
      tooltip="Your personal to-do list. AI agents and automations can also create tasks here for your review."
    >
      <TaskList />
    </PageContainer>
  );
}
