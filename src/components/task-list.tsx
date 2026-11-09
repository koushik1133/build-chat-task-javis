"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, Plus, Trash2, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { LoadMore } from "@/components/ui/load-more";
import { Pill, type Tone } from "@/components/ui/pill";
import { ErrorState } from "@/components/ui/feedback";
import { timeAgo } from "@/lib/utils";

/** Mirrors TASK_PRIORITIES in src/lib/tasks/store.ts (client-safe copy: the store imports the DB). */
const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
type Priority = (typeof PRIORITIES)[number];
const PRIORITY_TONE: Record<Priority, Tone> = { low: "neutral", normal: "info", high: "warning", urgent: "danger" };

type Task = {
  id: string;
  title: string;
  done: boolean;
  due_at: string | null;
  assignee_id: string | null;
  priority: Priority;
  overdue: boolean;
  created_at: string;
};
type Member = { userId: string | null; email: string | null; isSelf: boolean };

/** `datetime-local` value (local wall time) → ISO with offset, or null. */
function localToIso(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function dueLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function TaskList({ initialOverdueOnly = false }: { initialOverdueOnly?: boolean }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [draft, setDraft] = useState("");
  const [due, setDue] = useState("");
  const [assignee, setAssignee] = useState("");
  const [priority, setPriority] = useState<Priority>("normal");
  const [members, setMembers] = useState<Member[]>([]);
  const [overdueOnly, setOverdueOnly] = useState(initialOverdueOnly);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const listUrl = useCallback((c?: string | null) => `/api/tasks?limit=50${overdueOnly ? "&overdue=1" : ""}${c ? `&cursor=${encodeURIComponent(c)}` : ""}`, [overdueOnly]);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch(listUrl()).then((r) => r.json());
      setTasks(r.tasks ?? []);
      setCursor(typeof r.next_cursor === "string" ? r.next_cursor : null);
    } catch {
      setError("Could not load tasks.");
    }
  }, [listUrl]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await fetch(listUrl(cursor)).then((r) => r.json());
      const next: Task[] = r.tasks ?? [];
      setTasks((arr) => {
        const seen = new Set(arr.map((t) => t.id));
        return [...arr, ...next.filter((t) => !seen.has(t.id))];
      });
      setCursor(typeof r.next_cursor === "string" ? r.next_cursor : null);
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    fetch("/api/team")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { members?: Member[] } | null) => setMembers((j?.members ?? []).filter((m) => m.userId)))
      .catch(() => setMembers([]));
  }, []);

  const memberLabel = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) if (m.userId) map.set(m.userId, m.isSelf ? "You" : m.email ?? m.userId.slice(0, 8));
    return map;
  }, [members]);

  async function add() {
    const title = draft.trim();
    if (!title) return;
    setDraft("");
    const body: Record<string, unknown> = { title, priority };
    const dueIso = localToIso(due);
    if (dueIso) body.due_at = dueIso;
    if (assignee) body.assignee_id = assignee;
    const res = await fetch("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) setError("Could not add the task.");
    setDue("");
    void refresh();
  }

  async function patch(id: string, changes: Partial<Pick<Task, "done" | "due_at" | "assignee_id" | "priority">>) {
    setTasks((arr) => arr.map((x) => (x.id === id ? { ...x, ...changes, overdue: computeOverdue({ ...x, ...changes }) } : x)));
    const res = await fetch("/api/tasks", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, ...changes }) });
    if (!res.ok) {
      setError("Could not update the task.");
      void refresh();
    }
  }

  async function remove(id: string) {
    setTasks((arr) => arr.filter((x) => x.id !== id));
    await fetch("/api/tasks", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
  }

  const open = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);

  return (
    <div className="space-y-6">
      <form
        className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1fr_auto_auto_auto_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add a task…" aria-label="Task title" />
        <Input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date" className="min-w-0" />
        <Select value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Assignee">
          <option value="">Unassigned</option>
          {members.map((m) => (
            <option key={m.userId ?? ""} value={m.userId ?? ""}>
              {m.isSelf ? "Me" : m.email ?? m.userId}
            </option>
          ))}
        </Select>
        <Select value={priority} onChange={(e) => setPriority(e.target.value as Priority)} aria-label="Priority">
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p[0].toUpperCase() + p.slice(1)}
            </option>
          ))}
        </Select>
        <Button type="submit" disabled={!draft.trim()} aria-label="Add task">
          <Plus className="h-4 w-4" />
        </Button>
      </form>

      <div className="flex items-center gap-2 text-xs">
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" className="h-4 w-4 accent-primary" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} />
          Overdue only
        </label>
      </div>

      {error ? <ErrorState message={error} onRetry={() => void refresh()} /> : null}

      <Section title={`Open (${open.length})`} tasks={open} members={members} memberLabel={memberLabel} onPatch={patch} onDelete={remove} />
      {done.length > 0 && <Section title={`Done (${done.length})`} tasks={done} members={members} memberLabel={memberLabel} onPatch={patch} onDelete={remove} dim />}
      <LoadMore hasMore={Boolean(cursor)} loading={loadingMore} count={tasks.length} onMore={loadMore} noun="tasks" />
    </div>
  );
}

function computeOverdue(t: { done: boolean; due_at: string | null }): boolean {
  return !t.done && Boolean(t.due_at) && Date.parse(t.due_at as string) < Date.now();
}

function Section({
  title,
  tasks,
  members,
  memberLabel,
  onPatch,
  onDelete,
  dim,
}: {
  title: string;
  tasks: Task[];
  members: Member[];
  memberLabel: Map<string, string>;
  onPatch: (id: string, changes: Partial<Pick<Task, "done" | "due_at" | "assignee_id" | "priority">>) => void;
  onDelete: (id: string) => void;
  dim?: boolean;
}) {
  return (
    <div>
      <h2 className="mb-2 text-sm font-semibold">{title}</h2>
      {tasks.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing here.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {tasks.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 sm:flex-nowrap">
              <input type="checkbox" checked={t.done} onChange={() => onPatch(t.id, { done: !t.done })} className="h-4 w-4 accent-primary" aria-label={`Mark ${t.title} ${t.done ? "open" : "done"}`} />
              <div className="min-w-0 flex-1">
                <div className={dim ? "text-sm text-muted-foreground line-through" : "text-sm"}>{t.title}</div>
                <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span>{timeAgo(t.created_at)}</span>
                  {t.due_at ? (
                    <Pill tone={t.overdue ? "danger" : "neutral"} title={new Date(t.due_at).toLocaleString()}>
                      <CalendarClock className="h-3 w-3" />
                      {t.overdue ? `Overdue · ${dueLabel(t.due_at)}` : dueLabel(t.due_at)}
                    </Pill>
                  ) : null}
                  {t.assignee_id ? (
                    <Pill tone="accent">
                      <UserRound className="h-3 w-3" />
                      {memberLabel.get(t.assignee_id) ?? t.assignee_id.slice(0, 8)}
                    </Pill>
                  ) : null}
                  {t.priority !== "normal" ? <Pill tone={PRIORITY_TONE[t.priority]}>{t.priority}</Pill> : null}
                </div>
              </div>
              {!dim ? (
                <div className="flex items-center gap-1">
                  <Select value={t.priority} onChange={(e) => onPatch(t.id, { priority: e.target.value as Priority })} aria-label="Priority" className="h-8 text-xs">
                    {PRIORITIES.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </Select>
                  <Select value={t.assignee_id ?? ""} onChange={(e) => onPatch(t.id, { assignee_id: e.target.value || null })} aria-label="Assignee" className="h-8 text-xs">
                    <option value="">Unassigned</option>
                    {members.map((m) => (
                      <option key={m.userId ?? ""} value={m.userId ?? ""}>
                        {m.isSelf ? "Me" : m.email ?? m.userId}
                      </option>
                    ))}
                  </Select>
                  <Input
                    type="datetime-local"
                    className="h-8 w-[11.5rem] text-xs"
                    aria-label="Due date"
                    defaultValue={t.due_at ? toLocalInput(t.due_at) : ""}
                    onBlur={(e) => {
                      const iso = localToIso(e.target.value);
                      if (iso !== t.due_at) onPatch(t.id, { due_at: iso });
                    }}
                  />
                </div>
              ) : null}
              <Button variant="ghost" size="icon" onClick={() => onDelete(t.id)} aria-label={`Delete ${t.title}`}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** ISO → `datetime-local` value in the viewer's zone. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
