"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { FolderKanban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/input";
import { Empty, ErrorState, SkeletonList } from "@/components/ui/feedback";
import { Pill } from "@/components/ui/pill";
import type { ProjectTaskDTO } from "@/lib/projects/pure";
import { cn } from "@/lib/utils";
import { PRIORITY_TONE, fmtDue, isPast, jsonFetch } from "./shared";

/**
 * "My tasks" section for /tasks: open tasks assigned to the caller across
 * projects, grouped by project, soonest due first. Sits above the personal
 * task list and never imports server code.
 */
export function MyTasksPanel({ className }: { className?: string }) {
  const [tasks, setTasks] = useState<ProjectTaskDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const d = await jsonFetch<{ tasks: ProjectTaskDTO[] }>(`/api/me/tasks${showDone ? "?all=1" : ""}`, { fallback: "Could not load your tasks" });
      setTasks(d.tasks);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your tasks");
    }
  }, [showDone]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => {
    const map = new Map<string, { id: string | null; name: string; color: string | null; tasks: ProjectTaskDTO[] }>();
    for (const t of tasks ?? []) {
      const key = t.project_id ?? "__none__";
      const g = map.get(key) ?? { id: t.project_id, name: t.project_name ?? "No project", color: t.project_color ?? null, tasks: [] };
      g.tasks.push(t);
      map.set(key, g);
    }
    return [...map.values()];
  }, [tasks]);

  async function toggle(t: ProjectTaskDTO) {
    const next = !t.done;
    setTasks((cur) => (cur ?? []).map((x) => (x.id === t.id ? { ...x, done: next } : x)));
    try {
      await jsonFetch(`/api/projects/tasks/${encodeURIComponent(t.id)}`, { method: "PATCH", body: JSON.stringify({ done: next }), fallback: "Could not update task" });
      if (!showDone && next) setTasks((cur) => (cur ?? []).filter((x) => x.id !== t.id));
    } catch (err) {
      setTasks((cur) => (cur ?? []).map((x) => (x.id === t.id ? { ...x, done: !next } : x)));
      setError(err instanceof Error ? err.message : "Could not update task");
    }
  }

  return (
    <section aria-labelledby="my-tasks-heading" className={cn("rounded-xl border border-border bg-card p-4", className)}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="my-tasks-heading" className="text-base font-semibold">
          My tasks <span className="text-sm font-normal text-muted-foreground">across projects</span>
        </h2>
        <div className="flex items-center gap-3">
          <Checkbox label="Show done" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
          <Button asChild variant="outline" size="sm">
            <Link href="/projects">
              <FolderKanban className="h-4 w-4" aria-hidden /> Projects
            </Link>
          </Button>
        </div>
      </div>
      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : tasks === null ? (
        <SkeletonList count={3} itemClassName="h-10" label="Loading your tasks…" />
      ) : tasks.length === 0 ? (
        <Empty title="Nothing assigned to you" text="Tasks assigned to you inside projects show up here, soonest due first." />
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <div key={g.id ?? "none"}>
              <div className="mb-1.5 flex items-center gap-2 text-sm font-medium">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: g.color ?? "hsl(var(--primary))" }} aria-hidden />
                {g.id ? (
                  <Link href={`/projects/${encodeURIComponent(g.id)}?tab=tasks`} className="hover:underline">
                    {g.name}
                  </Link>
                ) : (
                  g.name
                )}
                <span className="text-xs text-muted-foreground">{g.tasks.length}</span>
              </div>
              <ul className="divide-y divide-border rounded-lg border border-border">
                {g.tasks.map((t) => {
                  const late = !t.done && isPast(t.due_at);
                  return (
                    <li key={t.id} className="flex items-center gap-3 px-3 py-2">
                      <Checkbox label={<span className="sr-only">Mark {t.title} {t.done ? "open" : "done"}</span>} checked={t.done} onChange={() => void toggle(t)} />
                      <span className={cn("min-w-0 flex-1 truncate text-sm", t.done && "text-muted-foreground line-through")}>{t.title}</span>
                      {t.priority && <Pill tone={PRIORITY_TONE[t.priority]}>{t.priority}</Pill>}
                      <span className={cn("shrink-0 text-xs tabular-nums", late ? "font-medium text-red-600 dark:text-red-400" : "text-muted-foreground")}>{fmtDue(t.due_at)}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
