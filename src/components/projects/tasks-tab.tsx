"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { LayoutGrid, List, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Empty, ErrorState, SkeletonList } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { Checkbox, Input, Select } from "@/components/ui/input";
import { Pill } from "@/components/ui/pill";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { TASK_PRIORITIES, type MilestoneDTO, type ProjectDTO, type ProjectTaskDTO, type TaskPriority } from "@/lib/projects/pure";
import { cn } from "@/lib/utils";
import type { Notice } from "./types";
import { PRIORITY_TONE, fmtDue, hours, isPast, isoToLocal, jsonFetch, localToIso, memberLabel, type MemberOption } from "./shared";

type View = "board" | "list";
type Column = "todo" | "overdue" | "done";
const COLUMNS: ReadonlyArray<{ id: Column; label: string }> = [
  { id: "overdue", label: "Overdue" },
  { id: "todo", label: "To do" },
  { id: "done", label: "Done" },
];

function columnOf(t: ProjectTaskDTO): Column {
  if (t.done) return "done";
  return isPast(t.due_at) ? "overdue" : "todo";
}

export function TasksTab({ project, milestones, members, reloadProject, notify }: { project: ProjectDTO; milestones: MilestoneDTO[]; members: MemberOption[]; reloadProject: () => Promise<void>; notify: (tone: Notice["tone"], text: string) => void }) {
  const [tasks, setTasks] = useState<ProjectTaskDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("board");
  const [quick, setQuick] = useState("");
  const [editing, setEditing] = useState<ProjectTaskDTO | null>(null);
  const [filterMilestone, setFilterMilestone] = useState("");
  const [filterAssignee, setFilterAssignee] = useState("");
  const readOnly = Boolean(project.archived_at);

  const load = useCallback(async () => {
    setError(null);
    try {
      const d = await jsonFetch<{ tasks: ProjectTaskDTO[] }>(`/api/projects/${encodeURIComponent(project.id)}/tasks`, { fallback: "Could not load tasks" });
      setTasks(d.tasks);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load tasks");
    }
  }, [project.id]);
  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(
    () => (tasks ?? []).filter((t) => (!filterMilestone || t.milestone_id === filterMilestone) && (!filterAssignee || t.assignee_id === filterAssignee)),
    [tasks, filterMilestone, filterAssignee]
  );
  const milestoneName = (id: string | null) => (id ? milestones.find((m) => m.id === id)?.name ?? "—" : "—");

  async function patch(t: ProjectTaskDTO, body: Record<string, unknown>, okText?: string) {
    const prev = tasks;
    setTasks((cur) => (cur ?? []).map((x) => (x.id === t.id ? { ...x, ...(body as Partial<ProjectTaskDTO>) } : x)));
    try {
      const d = await jsonFetch<{ task: ProjectTaskDTO }>(`/api/projects/tasks/${encodeURIComponent(t.id)}`, { method: "PATCH", body: JSON.stringify(body), fallback: "Could not update task" });
      setTasks((cur) => (cur ?? []).map((x) => (x.id === t.id ? d.task : x)));
      if (okText) notify("success", okText);
      void reloadProject();
    } catch (err) {
      setTasks(prev);
      notify("error", err instanceof Error ? err.message : "Could not update task");
    }
  }

  async function quickAdd(e: React.FormEvent) {
    e.preventDefault();
    const title = quick.trim();
    if (!title) return;
    setQuick("");
    try {
      const d = await jsonFetch<{ task: ProjectTaskDTO }>(`/api/projects/${encodeURIComponent(project.id)}/tasks`, { method: "POST", body: JSON.stringify({ title, ...(filterMilestone ? { milestone_id: filterMilestone } : {}), ...(filterAssignee ? { assignee_id: filterAssignee } : {}) }), fallback: "Could not add task" });
      setTasks((cur) => [...(cur ?? []), d.task]);
      void reloadProject();
    } catch (err) {
      setQuick(title);
      notify("error", err instanceof Error ? err.message : "Could not add task");
    }
  }

  function move(t: ProjectTaskDTO, to: Column) {
    if (to === "done") return void patch(t, { done: true });
    if (to === "todo" && t.done) return void patch(t, { done: false });
    if (to === "todo" && isPast(t.due_at)) return setEditing(t); // needs a new due date
    if (to === "overdue") return setEditing(t);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {!readOnly && (
          <form onSubmit={quickAdd} className="flex flex-1 gap-2 sm:max-w-md">
            <Input value={quick} onChange={(e) => setQuick(e.target.value)} placeholder="Quick add a task and press Enter" aria-label="New task title" maxLength={200} />
            <Button type="submit" touch disabled={!quick.trim()} aria-label="Add task">
              <Plus className="h-4 w-4" aria-hidden />
            </Button>
          </form>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Select value={filterMilestone} onChange={(e) => setFilterMilestone(e.target.value)} aria-label="Filter by milestone" className="h-9 text-xs">
            <option value="">All milestones</option>
            {milestones.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
          <Select value={filterAssignee} onChange={(e) => setFilterAssignee(e.target.value)} aria-label="Filter by assignee" className="h-9 text-xs">
            <option value="">Everyone</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </Select>
          <div className="inline-flex rounded-md border border-border" role="group" aria-label="View">
            <button type="button" onClick={() => setView("board")} aria-pressed={view === "board"} className={cn("inline-flex h-9 items-center gap-1 px-3 text-xs", view === "board" && "bg-secondary")}>
              <LayoutGrid className="h-4 w-4" aria-hidden /> Board
            </button>
            <button type="button" onClick={() => setView("list")} aria-pressed={view === "list"} className={cn("inline-flex h-9 items-center gap-1 border-l border-border px-3 text-xs", view === "list" && "bg-secondary")}>
              <List className="h-4 w-4" aria-hidden /> List
            </button>
          </div>
        </div>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : tasks === null ? (
        <SkeletonList count={4} itemClassName="h-12" label="Loading tasks…" />
      ) : visible.length === 0 ? (
        <Empty title={tasks.length === 0 ? "No tasks yet" : "No tasks match"} text={tasks.length === 0 ? "Quick add the first task above, then set owners and due dates." : "Try clearing the filters."} />
      ) : view === "board" ? (
        <div className="grid gap-3 md:grid-cols-3">
          {COLUMNS.map((col) => {
            const items = visible.filter((t) => columnOf(t) === col.id);
            return (
              <section key={col.id} aria-labelledby={`col-${col.id}`} className="rounded-xl border border-border bg-card p-3">
                <h3 id={`col-${col.id}`} className="mb-2 flex items-center justify-between text-sm font-semibold">
                  <span className={cn(col.id === "overdue" && items.length > 0 && "text-red-600 dark:text-red-400")}>{col.label}</span>
                  <span className="text-xs font-normal text-muted-foreground">{items.length}</span>
                </h3>
                <ul className="space-y-2">
                  {items.map((t) => (
                    <li key={t.id} className="rounded-lg border border-border bg-background p-3">
                      <div className="flex items-start gap-2">
                        <Checkbox label={<span className="sr-only">Mark {t.title} {t.done ? "open" : "done"}</span>} checked={t.done} onChange={() => void patch(t, { done: !t.done })} disabled={readOnly} />
                        <button type="button" onClick={() => setEditing(t)} className={cn("min-w-0 flex-1 text-left text-sm hover:underline", t.done && "text-muted-foreground line-through")}>
                          {t.title}
                        </button>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        {t.priority && <Pill tone={PRIORITY_TONE[t.priority]}>{t.priority}</Pill>}
                        <span className={cn(!t.done && isPast(t.due_at) && "font-medium text-red-600 dark:text-red-400")}>{fmtDue(t.due_at)}</span>
                        <span>· {memberLabel(members, t.assignee_id)}</span>
                        {t.estimate_minutes ? <span>· {hours(t.estimate_minutes)}</span> : null}
                      </div>
                      {!readOnly && (
                        <label className="mt-2 block text-xs text-muted-foreground">
                          <span className="sr-only">Move {t.title} to</span>
                          <Select value={col.id} onChange={(e) => move(t, e.target.value as Column)} className="h-8 text-xs">
                            {COLUMNS.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.label}
                              </option>
                            ))}
                          </Select>
                        </label>
                      )}
                    </li>
                  ))}
                  {items.length === 0 && <li className="rounded-lg border border-dashed border-border p-3 text-center text-xs text-muted-foreground">Nothing here</li>}
                </ul>
              </section>
            );
          })}
        </div>
      ) : (
        <TableScroller label="Project tasks">
          <table className="w-full min-w-[720px] text-sm">
            <thead className={THEAD}>
              <tr>
                <th className={cn(TH, "w-8")}>
                  <span className="sr-only">Done</span>
                </th>
                <th className={TH}>Task</th>
                <th className={TH}>Assignee</th>
                <th className={TH}>Due</th>
                <th className={TH}>Priority</th>
                <th className={TH}>Milestone</th>
                <th className={cn(TH, "text-right")}>Est.</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((t) => (
                <tr key={t.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    <Checkbox label={<span className="sr-only">Mark {t.title} {t.done ? "open" : "done"}</span>} checked={t.done} onChange={() => void patch(t, { done: !t.done })} disabled={readOnly} />
                  </td>
                  <td className="px-3 py-2">
                    <button type="button" onClick={() => setEditing(t)} className={cn("text-left hover:underline", t.done && "text-muted-foreground line-through")}>
                      {t.title}
                    </button>
                  </td>
                  <td className="px-3 py-2">{memberLabel(members, t.assignee_id)}</td>
                  <td className={cn("px-3 py-2 tabular-nums", !t.done && isPast(t.due_at) && "font-medium text-red-600 dark:text-red-400")}>{fmtDue(t.due_at)}</td>
                  <td className="px-3 py-2">{t.priority ? <Pill tone={PRIORITY_TONE[t.priority]}>{t.priority}</Pill> : "—"}</td>
                  <td className="px-3 py-2">{milestoneName(t.milestone_id)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{t.estimate_minutes ? hours(t.estimate_minutes) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      )}

      {editing && (
        <TaskDialog
          task={editing}
          milestones={milestones}
          members={members}
          tasks={tasks ?? []}
          readOnly={readOnly}
          onClose={() => setEditing(null)}
          onSave={async (body) => {
            await patch(editing, body, "Task updated.");
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function TaskDialog({ task, milestones, members, tasks, readOnly, onClose, onSave }: { task: ProjectTaskDTO; milestones: MilestoneDTO[]; members: MemberOption[]; tasks: ProjectTaskDTO[]; readOnly: boolean; onClose: () => void; onSave: (body: Record<string, unknown>) => Promise<void> }) {
  const [title, setTitle] = useState(task.title);
  const [assignee, setAssignee] = useState(task.assignee_id ?? "");
  const [due, setDue] = useState(isoToLocal(task.due_at));
  const [priority, setPriority] = useState<TaskPriority | "">(task.priority ?? "");
  const [milestone, setMilestone] = useState(task.milestone_id ?? "");
  const [estimate, setEstimate] = useState(task.estimate_minutes ? String(task.estimate_minutes / 60) : "");
  const [dependsOn, setDependsOn] = useState<string[]>(task.depends_on);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await onSave({
        title: title.trim(),
        assignee_id: assignee || null,
        due_at: localToIso(due),
        priority: priority || null,
        milestone_id: milestone || null,
        estimate_minutes: estimate ? Math.round(Number(estimate) * 60) : null,
        depends_on: dependsOn,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={readOnly ? "Task" : "Edit task"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Title" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} disabled={readOnly} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Assignee">
            <Select value={assignee} onChange={(e) => setAssignee(e.target.value)} disabled={readOnly}>
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
              {assignee && !members.some((m) => m.id === assignee) && <option value={assignee}>{assignee.slice(0, 8)}…</option>}
            </Select>
          </Field>
          <Field label="Due">
            <Input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} disabled={readOnly} />
          </Field>
          <Field label="Priority">
            <Select value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority | "")} disabled={readOnly}>
              <option value="">None</option>
              {TASK_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Milestone">
            <Select value={milestone} onChange={(e) => setMilestone(e.target.value)} disabled={readOnly}>
              <option value="">None</option>
              {milestones.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Estimate (hours)">
          <Input type="number" min={0} step="0.25" inputMode="decimal" value={estimate} onChange={(e) => setEstimate(e.target.value)} disabled={readOnly} />
        </Field>
        {tasks.length > 1 && (
          <fieldset className="rounded-lg border border-border p-3">
            <legend className="px-1 text-xs font-medium text-muted-foreground">Depends on</legend>
            <div className="max-h-32 space-y-1 overflow-y-auto">
              {tasks
                .filter((t) => t.id !== task.id)
                .map((t) => (
                  <Checkbox
                    key={t.id}
                    label={<span className={cn("text-sm", t.done && "text-muted-foreground line-through")}>{t.title}</span>}
                    checked={dependsOn.includes(t.id)}
                    onChange={(e) => setDependsOn((cur) => (e.target.checked ? [...cur, t.id] : cur.filter((x) => x !== t.id)))}
                    disabled={readOnly}
                  />
                ))}
            </div>
          </fieldset>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" touch onClick={onClose} disabled={busy}>
            {readOnly ? "Close" : "Cancel"}
          </Button>
          {!readOnly && (
            <Button type="submit" touch disabled={busy || !title.trim()}>
              {busy ? "Saving…" : "Save"}
            </Button>
          )}
        </DialogFooter>
      </form>
    </Dialog>
  );
}
