import { TaskList } from "@/components/task-list";

export default function TasksPage() {
  return (
    <div className="h-full overflow-y-auto px-8 py-8">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Auto-extracted from your chats — and you can add your own.
        </p>
        <div className="mt-8">
          <TaskList />
        </div>
      </div>
    </div>
  );
}
