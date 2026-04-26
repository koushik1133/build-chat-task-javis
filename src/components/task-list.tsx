"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { timeAgo } from "@/lib/utils";

type Task = { id: string; title: string; done: boolean; created_at: string };

export function TaskList() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [draft, setDraft] = useState("");

  async function refresh() {
    const r = await fetch("/api/tasks").then((r) => r.json());
    setTasks(r.tasks ?? []);
  }
  useEffect(() => {
    refresh();
  }, []);

  async function add() {
    const title = draft.trim();
    if (!title) return;
    setDraft("");
    await fetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    refresh();
  }

  async function toggle(t: Task) {
    setTasks((arr) => arr.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x)));
    await fetch("/api/tasks", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: t.id, done: !t.done }),
    });
  }

  async function remove(id: string) {
    setTasks((arr) => arr.filter((x) => x.id !== id));
    await fetch("/api/tasks", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
  }

  const open = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);

  return (
    <div className="space-y-6">
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a task…"
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <Button onClick={add} disabled={!draft.trim()}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      <Section title={`Open (${open.length})`} tasks={open} onToggle={toggle} onDelete={remove} />
      {done.length > 0 && (
        <Section title={`Done (${done.length})`} tasks={done} onToggle={toggle} onDelete={remove} dim />
      )}
    </div>
  );
}

function Section({
  title,
  tasks,
  onToggle,
  onDelete,
  dim,
}: {
  title: string;
  tasks: Task[];
  onToggle: (t: Task) => void;
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
            <li key={t.id} className="flex items-center gap-3 px-3 py-2">
              <input
                type="checkbox"
                checked={t.done}
                onChange={() => onToggle(t)}
                className="h-4 w-4 accent-primary"
              />
              <div className="min-w-0 flex-1">
                <div className={dim ? "text-sm text-muted-foreground line-through" : "text-sm"}>
                  {t.title}
                </div>
                <div className="text-[11px] text-muted-foreground">{timeAgo(t.created_at)}</div>
              </div>
              <Button variant="ghost" size="icon" onClick={() => onDelete(t.id)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
