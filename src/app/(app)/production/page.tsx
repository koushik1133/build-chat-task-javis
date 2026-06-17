"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import {
  Plus, Undo2, CheckCircle2, XCircle, MoreHorizontal, Clock,
  Settings2, Pencil, Trash2, X, GripVertical, Shield,
  Tag, Calendar, User, Zap, ChevronDown, Save, AlertCircle,
  Search, Filter, History,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { NotificationBell } from "@/components/notification-bell";
import { timeAgo, cn } from "@/lib/utils";
import { validateMove, sortByPriority } from "@/lib/production-board";

/* ─── Types ─────────────────────────────────────────────────────────────── */
type Column = { id: string; label: string; hitl: boolean; color: string };
type CardField = "priority" | "due_date" | "tags" | "assignee" | "automation";

type PTask = {
  id: string;
  title: string;
  status: string;
  priority: "low" | "medium" | "high";
  description: string | null;
  due_date: string | null;
  tags: string;
  assignee: string | null;
  automation: string | null;
  created_at: string;
  approved_at: string | null;
};

type BoardConfig = {
  id: string;
  name: string;
  template: string;
  columns: Column[];
  card_fields: CardField[];
};

type Toast = { id: string; msg: string; kind: "ok" | "err" };
type ActivityEntry = { action: string; details: Record<string, unknown>; created_at: string };
type FilterMode = "all" | "hitl" | "overdue" | "high";

/* ─── Templates ─────────────────────────────────────────────────────────── */
const TEMPLATES: Record<string, { label: string; columns: Column[] }> = {
  default: {
    label: "Default",
    columns: [
      { id: "pending_approval", label: "Pending Approval", hitl: true,  color: "#f59e0b" },
      { id: "todo",             label: "To Do",             hitl: false, color: "#6366f1" },
      { id: "done",             label: "Done",              hitl: false, color: "#22c55e" },
    ],
  },
  software_dev: {
    label: "Software Dev",
    columns: [
      { id: "backlog",  label: "Backlog",    hitl: false, color: "#94a3b8" },
      { id: "sprint",   label: "In Sprint",  hitl: false, color: "#6366f1" },
      { id: "review",   label: "In Review",  hitl: true,  color: "#f59e0b" },
      { id: "staging",  label: "Staging",    hitl: false, color: "#f97316" },
      { id: "done",     label: "Done",       hitl: false, color: "#22c55e" },
    ],
  },
  sales_pipeline: {
    label: "Sales Pipeline",
    columns: [
      { id: "lead",        label: "Lead",        hitl: false, color: "#94a3b8" },
      { id: "qualified",   label: "Qualified",   hitl: false, color: "#6366f1" },
      { id: "proposal",    label: "Proposal",    hitl: true,  color: "#f59e0b" },
      { id: "negotiation", label: "Negotiation", hitl: true,  color: "#f97316" },
      { id: "won",         label: "Won",         hitl: false, color: "#22c55e" },
    ],
  },
  agency: {
    label: "Agency",
    columns: [
      { id: "brief",      label: "Brief",         hitl: false, color: "#94a3b8" },
      { id: "production", label: "In Production", hitl: false, color: "#6366f1" },
      { id: "review",     label: "Client Review", hitl: true,  color: "#f59e0b" },
      { id: "revision",   label: "Revision",      hitl: false, color: "#f97316" },
      { id: "delivered",  label: "Delivered",     hitl: false, color: "#22c55e" },
    ],
  },
  content: {
    label: "Content Calendar",
    columns: [
      { id: "ideas",     label: "Ideas",     hitl: false, color: "#94a3b8" },
      { id: "writing",   label: "Writing",   hitl: false, color: "#6366f1" },
      { id: "review",    label: "Review",    hitl: true,  color: "#f59e0b" },
      { id: "scheduled", label: "Scheduled", hitl: false, color: "#f97316" },
      { id: "published", label: "Published", hitl: false, color: "#22c55e" },
    ],
  },
  support: {
    label: "Support",
    columns: [
      { id: "open",        label: "Open",        hitl: false, color: "#ef4444" },
      { id: "triaging",    label: "Triaging",    hitl: false, color: "#f59e0b" },
      { id: "in_progress", label: "In Progress", hitl: false, color: "#6366f1" },
      { id: "escalated",   label: "Escalated",   hitl: true,  color: "#f97316" },
      { id: "resolved",    label: "Resolved",    hitl: false, color: "#22c55e" },
    ],
  },
};

const PRIORITY_BADGE: Record<string, string> = {
  low:    "bg-secondary text-muted-foreground",
  medium: "bg-yellow-50 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-400",
  high:   "bg-red-50   text-red-700   dark:bg-red-950   dark:text-red-400",
};

const COLORS = ["#6366f1","#f97316","#22c55e","#f59e0b","#ef4444","#8b5cf6","#06b6d4","#94a3b8"];

/* ─── Helpers ────────────────────────────────────────────────────────────── */
function parseTags(raw: string): string[] {
  try { return JSON.parse(raw || "[]"); } catch { return []; }
}

/* ─── Main component ─────────────────────────────────────────────────────── */
export default function ProductionPage() {
  const [tasks,   setTasks]   = useState<PTask[]>([]);
  const [config,  setConfig]  = useState<BoardConfig | null>(null);
  const [loading, setLoading] = useState(true);

  // Quick-add
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Undo stack
  const [history, setHistory] = useState<PTask[][]>([]);

  // Card form (inline per column)
  const [showCardForm, setShowCardForm] = useState<string | null>(null);
  const [cardForm, setCardForm] = useState({ title: "", description: "", priority: "medium", due_date: "", tags: "", assignee: "", automation: "" });

  // Card edit modal
  const [editTask, setEditTask] = useState<PTask | null>(null);
  const [editForm, setEditForm] = useState({ title: "", description: "", priority: "medium", due_date: "", tags: "", assignee: "", automation: "" });
  const [editSaving, setEditSaving] = useState(false);

  // Settings drawer
  const [showSettings, setShowSettings] = useState(false);

  // Column inline editing
  const [editingCol, setEditingCol]   = useState<string | null>(null);
  const [editColLabel, setEditColLabel] = useState("");

  // Board name editing
  const [editingName, setEditingName] = useState(false);
  const [boardName, setBoardName]     = useState("");
  const boardNameSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Drag-and-drop  (cards + columns separately)
  const [dragTaskId, setDragTaskId]   = useState<string | null>(null);
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);
  const [dragColIdx,  setDragColIdx]  = useState<number | null>(null);
  const [overColIdx,  setOverColIdx]  = useState<number | null>(null);

  // Toast
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Filters & search
  const [filter, setFilter] = useState<FilterMode>("all");
  const [search, setSearch] = useState("");

  // Card activity timeline
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);

  // Reject reason modal
  const [rejectTarget, setRejectTarget] = useState<PTask | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  /* Load ------------------------------------------------------------------ */
  const load = useCallback(async () => {
    setLoading(true);
    const [tasksRes, cfgRes] = await Promise.allSettled([
      fetch("/api/production").then(r => r.json()),
      fetch("/api/production/config").then(r => r.json()),
    ]);
    if (tasksRes.status === "fulfilled") setTasks(tasksRes.value.tasks ?? []);
    if (cfgRes.status === "fulfilled" && cfgRes.value.config) {
      const cfg = cfgRes.value.config;
      const parsed: BoardConfig = {
        ...cfg,
        columns:     JSON.parse(cfg.columns     || "[]"),
        card_fields: JSON.parse(cfg.card_fields || "[]"),
      };
      setConfig(parsed);
      setBoardName(parsed.name);
    } else {
      const def: BoardConfig = { id: "", name: "My Board", template: "default", columns: TEMPLATES.default.columns, card_fields: ["priority","due_date","tags"] };
      setConfig(def);
      setBoardName(def.name);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  /* Toast ----------------------------------------------------------------- */
  const toast = useCallback((msg: string, kind: "ok" | "err" = "ok") => {
    const id = crypto.randomUUID();
    setToasts(t => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3000);
  }, []);

  /* Snapshot / Undo ------------------------------------------------------- */
  const snapshot = useCallback(() => setHistory(h => [...h.slice(-19), tasks]), [tasks]);

  function undo() {
    if (history.length === 0) return;
    setTasks(history[history.length - 1]);
    setHistory(h => h.slice(0, -1));
    toast("Undone");
  }

  /* Config save ----------------------------------------------------------- */
  const saveConfig = useCallback(async (updated: BoardConfig) => {
    setConfig(updated);
    await fetch("/api/production/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...updated, columns: JSON.stringify(updated.columns), card_fields: JSON.stringify(updated.card_fields) }),
    }).catch(() => {});
  }, []);

  /* Board name ------------------------------------------------------------- */
  function handleBoardNameChange(val: string) {
    setBoardName(val);
    if (!config) return;
    if (boardNameSaveTimer.current) clearTimeout(boardNameSaveTimer.current);
    boardNameSaveTimer.current = setTimeout(() => saveConfig({ ...config, name: val }), 600);
  }

  /* Add task -------------------------------------------------------------- */
  async function addTask(colId?: string) {
    const title = colId ? cardForm.title.trim() : input.trim();
    if (!title || !config) return;
    snapshot();
    const body: Record<string, unknown> = {
      title,
      status:   colId ?? (config.columns[0]?.id ?? "todo"),
      priority: colId ? cardForm.priority : "medium",
    };
    if (colId) {
      if (cardForm.description) body.description = cardForm.description;
      if (cardForm.due_date)    body.due_date     = cardForm.due_date;
      if (cardForm.tags)        body.tags         = JSON.stringify(cardForm.tags.split(",").map(t => t.trim()).filter(Boolean));
      if (cardForm.assignee)    body.assignee     = cardForm.assignee;
      if (cardForm.automation)  body.automation   = cardForm.automation;
    }
    const res = await fetch("/api/production", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).then(r => r.json()).catch(() => null);
    if (res?.task) {
      setTasks(t => [res.task, ...t]);
      toast("Card added");
    } else {
      toast("Failed to add card", "err");
    }
    if (colId) {
      setCardForm({ title: "", description: "", priority: "medium", due_date: "", tags: "", assignee: "", automation: "" });
      setShowCardForm(null);
    } else {
      setInput("");
    }
  }

  /* Move task -------------------------------------------------------------- */
  async function moveTask(id: string, newStatus: string) {
    const task = tasks.find(t => t.id === id);
    if (!task || task.status === newStatus) return;

    const check = validateMove(cols, task.status, newStatus);
    if (!check.ok) { toast(check.reason, "err"); return; }

    snapshot();
    setTasks(t => t.map(tk => tk.id === id ? { ...tk, status: newStatus } : tk));

    const res = await fetch(`/api/production/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus }),
    }).then(r => r.json()).catch(() => null);

    if (!res?.task) {
      toast("Move failed — reloading", "err");
      load();
      return;
    }

    setTasks(t => t.map(tk => tk.id === id ? res.task : tk));
    if (res.fired?.length > 0) {
      res.fired.forEach((a: { name: string; success: boolean; message: string; detail?: string }) =>
        toast(a.success ? `⚡ ${a.name}: ${a.message}` : `${a.name} failed: ${a.detail ?? a.message}`, a.success ? "ok" : "err")
      );
    }
  }

  /* Approve / Reject (HITL) ----------------------------------------------- */
  async function approve(id: string) {
    snapshot();
    const res = await fetch(`/api/production/${id}/approve`, { method: "POST" })
      .then(r => r.json()).catch(() => null);

    if (!res?.task) {
      toast(res?.error ?? "Approval failed", "err");
      return;
    }

    setTasks(t => t.map(tk => tk.id === id ? res.task : tk));
    toast(`Approved → ${res.next_column}`);

    if (res.fired?.length > 0) {
      res.fired.forEach((a: { name: string; success: boolean; message: string; detail?: string }) =>
        toast(a.success ? `⚡ ${a.name}: ${a.message}` : `${a.name} failed: ${a.detail ?? a.message}`, a.success ? "ok" : "err")
      );
    }
  }

  async function confirmReject() {
    if (!rejectTarget) return;
    snapshot();
    const res = await fetch(`/api/production/${rejectTarget.id}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: rejectReason }),
    }).catch(() => null);

    if (!res?.ok) { toast("Reject failed", "err"); return; }

    setTasks(t => t.filter(tk => tk.id !== rejectTarget.id));
    toast("Card rejected");
    setRejectTarget(null);
    setRejectReason("");
    if (editTask?.id === rejectTarget.id) setEditTask(null);
  }

  function promptReject(task: PTask) {
    setRejectTarget(task);
    setRejectReason("");
  }

  /* Edit task ------------------------------------------------------------- */
  function openEdit(task: PTask) {
    setEditTask(task);
    setEditForm({
      title:       task.title,
      description: task.description ?? "",
      priority:    task.priority,
      due_date:    task.due_date ?? "",
      tags:        parseTags(task.tags).join(", "),
      assignee:    task.assignee  ?? "",
      automation:  task.automation ?? "",
    });
    setActivity([]);
    setActivityLoading(true);
    fetch(`/api/production/${task.id}/activity`)
      .then(r => r.json())
      .then(d => setActivity(d.activity ?? []))
      .catch(() => {})
      .finally(() => setActivityLoading(false));
  }

  async function saveEdit() {
    if (!editTask) return;
    setEditSaving(true);
    const body: Record<string, unknown> = {
      title:       editForm.title.trim() || editTask.title,
      description: editForm.description.trim() || null,
      priority:    editForm.priority,
      due_date:    editForm.due_date || null,
      tags:        JSON.stringify(editForm.tags.split(",").map(t => t.trim()).filter(Boolean)),
      assignee:    editForm.assignee  || null,
      automation:  editForm.automation || null,
    };
    const res = await fetch(`/api/production/${editTask.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).then(r => r.json()).catch(() => null);
    if (res?.task) {
      setTasks(t => t.map(tk => tk.id === editTask.id ? res.task : tk));
      toast("Card saved");
      setEditTask(null);
    } else {
      toast("Save failed", "err");
    }
    setEditSaving(false);
  }

  /* Delete task ----------------------------------------------------------- */
  async function deleteTask(id: string) {
    snapshot();
    const r = await fetch(`/api/production/${id}`, { method: "DELETE" }).catch(() => null);
    if (r?.ok) { setTasks(t => t.filter(tk => tk.id !== id)); toast("Card deleted"); }
    else toast("Delete failed", "err");
    setEditTask(null);
  }

  /* Column management ------------------------------------------------------ */
  function addColumn() {
    if (!config) return;
    saveConfig({ ...config, columns: [...config.columns, { id: `col_${Date.now()}`, label: "New Column", hitl: false, color: "#6366f1" }] });
  }

  function updateColumn(id: string, patch: Partial<Column>) {
    if (!config) return;
    saveConfig({ ...config, columns: config.columns.map(c => c.id === id ? { ...c, ...patch } : c) });
  }

  function deleteColumn(id: string) {
    if (!config) return;
    const col = config.columns.find(c => c.id === id);
    const orphaned = tasks.filter(t => t.status === id).length;
    if (orphaned > 0 && !confirm(`"${col?.label}" has ${orphaned} card(s). Delete column and its cards?`)) return;
    if (orphaned > 0) tasks.filter(t => t.status === id).forEach(t => deleteTask(t.id));
    saveConfig({ ...config, columns: config.columns.filter(c => c.id !== id) });
  }

  function reorderColumn(fromIdx: number, toIdx: number) {
    if (!config || fromIdx === toIdx) return;
    const cols = [...config.columns];
    const [moved] = cols.splice(fromIdx, 1);
    cols.splice(toIdx, 0, moved);
    saveConfig({ ...config, columns: cols });
  }

  function toggleField(f: CardField) {
    if (!config) return;
    const fields = config.card_fields.includes(f)
      ? config.card_fields.filter(x => x !== f)
      : [...config.card_fields, f];
    saveConfig({ ...config, card_fields: fields as CardField[] });
  }

  function applyTemplate(templateId: string) {
    if (!config) return;
    const tmpl = TEMPLATES[templateId];
    if (!tmpl) return;
    saveConfig({ ...config, template: templateId, columns: tmpl.columns });
    toast(`Template "${tmpl.label}" applied`);
  }

  /* Drag-and-drop (cards) ------------------------------------------------- */
  function onCardDragStart(e: React.DragEvent, taskId: string) {
    setDragTaskId(taskId);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("type", "card");
  }
  function onColDragOver(e: React.DragEvent, colId: string) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverCol(colId);
  }
  function onColDrop(e: React.DragEvent, colId: string) {
    e.preventDefault();
    const type = e.dataTransfer.getData("type");
    if (type === "card" && dragTaskId) {
      const task = tasks.find(t => t.id === dragTaskId);
      if (task && task.status !== colId) {
        const check = validateMove(cols, task.status, colId);
        if (!check.ok) toast(check.reason, "err");
        else moveTask(dragTaskId, colId);
      }
    }
    setDragTaskId(null);
    setDragOverCol(null);
  }

  /* Drag-and-drop (column reorder in settings) ----------------------------- */
  function onColHeaderDragStart(idx: number) { setDragColIdx(idx); }
  function onColHeaderDragOver(e: React.DragEvent, idx: number) { e.preventDefault(); setOverColIdx(idx); }
  function onColHeaderDrop(idx: number) {
    if (dragColIdx !== null) reorderColumn(dragColIdx, idx);
    setDragColIdx(null); setOverColIdx(null);
  }

  /* Derived --------------------------------------------------------------- */
  const cols   = config?.columns   ?? [];
  const fields = config?.card_fields ?? [];
  const colIds = new Set(cols.map(c => c.id));
  const hitlColIds = new Set(cols.filter(c => c.hitl).map(c => c.id));
  const orphans = tasks.filter(t => !colIds.has(t.status));
  const lastColId = cols[cols.length - 1]?.id;
  const done = tasks.filter(t => t.status === lastColId).length;
  const inPipeline = tasks.length - done - orphans.length;
  const efficiency = tasks.length > 0 ? Math.round((done / tasks.length) * 100) : 0;
  const hitlPending = tasks.filter(t => hitlColIds.has(t.status)).length;

  function taskMatchesFilter(t: PTask): boolean {
    const q = search.trim().toLowerCase();
    if (q) {
      const hay = [t.title, t.description ?? "", t.assignee ?? "", parseTags(t.tags).join(" ")].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (filter === "hitl") return hitlColIds.has(t.status);
    if (filter === "overdue") return !!(t.due_date && new Date(t.due_date) < new Date() && t.status !== lastColId);
    if (filter === "high") return t.priority === "high";
    return true;
  }

  const visibleTasks = tasks.filter(taskMatchesFilter);

  if (loading) return (
    <div className="flex items-center justify-center h-full text-muted-foreground text-sm gap-2">
      <div className="h-4 w-4 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      Loading board…
    </div>
  );

  return (
    <div className="h-full flex flex-col overflow-hidden relative">

      {/* ── Toasts ─────────────────────────────────────────────────────── */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map(t => (
          <div key={t.id} className={cn(
            "flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm shadow-xl backdrop-blur border pointer-events-auto transition-all",
            t.kind === "ok" ? "bg-card border-border text-foreground" : "bg-red-50 border-red-200 text-red-700 dark:bg-red-950 dark:border-red-800 dark:text-red-400"
          )}>
            {t.kind === "err" ? <AlertCircle className="h-3.5 w-3.5 shrink-0" /> : <CheckCircle2 className="h-3.5 w-3.5 text-green-600 shrink-0" />}
            {t.msg}
          </div>
        ))}
      </div>

      {/* ── Top bar ────────────────────────────────────────────────────── */}
      <div className="border-b border-border bg-card px-4 py-3 sm:px-6 shrink-0">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            {editingName ? (
              <input
                value={boardName}
                onChange={e => handleBoardNameChange(e.target.value)}
                onBlur={() => setEditingName(false)}
                onKeyDown={e => e.key === "Enter" && setEditingName(false)}
                autoFocus
                className="w-full max-w-[12rem] border-b border-primary bg-transparent text-base font-semibold outline-none sm:max-w-xs sm:text-lg"
              />
            ) : (
              <button
                className="group flex min-w-0 items-center gap-1.5 text-base font-semibold transition-colors hover:text-primary sm:text-lg"
                onClick={() => setEditingName(true)}
              >
                <span className="truncate">{boardName || "My Board"}</span>
                <Pencil className="h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-50" />
              </button>
            )}
            <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
              {cols.length} columns · {tasks.length} cards
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="hidden items-center gap-3 border-r border-border pr-2 text-xs xl:flex xl:gap-4">
            <span className="text-muted-foreground">Pipeline <strong className="text-foreground">{inPipeline}</strong></span>
            <span className="text-muted-foreground">Done <strong className="text-foreground">{done}</strong></span>
            <span className={cn("font-semibold", efficiency >= 70 ? "text-green-600" : efficiency >= 40 ? "text-yellow-600" : "text-muted-foreground")}>
              {efficiency}% efficiency
            </span>
            {hitlPending > 0 && (
              <button
                onClick={() => setFilter(f => f === "hitl" ? "all" : "hitl")}
                className={cn(
                  "flex items-center gap-1 text-amber-600 font-semibold animate-pulse",
                  filter === "hitl" && "underline"
                )}
              >
                <Shield className="h-3 w-3" /> {hitlPending} awaiting approval
              </button>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={undo} disabled={history.length === 0}>
            <Undo2 className="h-3.5 w-3.5" /> Undo
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowSettings(true)}>
            <Settings2 className="h-3.5 w-3.5" /> Configure
          </Button>
            <NotificationBell />
          </div>
        </div>
      </div>

      {/* ── Search + filters ───────────────────────────────────────────── */}
      <div className="border-b border-border bg-card/50 px-4 py-2 sm:px-6 shrink-0">
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="relative flex-1 min-w-[160px] max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search cards…"
            className="w-full rounded-lg border border-border bg-background pl-8 pr-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1 overflow-x-auto pb-0.5 sm:pb-0">
          <Filter className="mr-1 hidden h-3.5 w-3.5 shrink-0 text-muted-foreground sm:block" />
          {([
            { id: "all" as FilterMode, label: "All" },
            { id: "hitl" as FilterMode, label: "Needs Approval", count: hitlPending },
            { id: "overdue" as FilterMode, label: "Overdue" },
            { id: "high" as FilterMode, label: "High Priority" },
          ]).map(f => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={cn(
                "shrink-0 rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                filter === f.id ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"
              )}
            >
              {f.label}{f.count ? ` (${f.count})` : ""}
            </button>
          ))}
        </div>
        </div>
      </div>

      {/* ── Quick-add bar ──────────────────────────────────────────────── */}
      <div className="border-b border-border bg-card/50 px-4 py-2 sm:px-6 shrink-0 flex items-center gap-2">
        <input
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === "Enter" && addTask()}
          placeholder={`Quick add to "${cols[0]?.label ?? "first column"}"…`}
          className="flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
        />
        <Button size="sm" onClick={() => addTask()} disabled={!input.trim()}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {/* ── Orphan warning ─────────────────────────────────────────────── */}
      {orphans.length > 0 && (
        <div className="border-b border-amber-200 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-800 px-4 py-2 sm:px-6 flex items-center gap-2 text-xs text-amber-700 dark:text-amber-400 shrink-0 flex-wrap">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {orphans.length} card(s) belong to deleted columns. Move them to an active column or delete.
          <div className="flex gap-1 ml-2">
            {orphans.slice(0, 3).map(t => (
              <button key={t.id} onClick={() => openEdit(t)}
                className="underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-200 truncate max-w-24">
                {t.title}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Kanban board ───────────────────────────────────────────────── */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden p-3 sm:p-4">
        <div className="flex gap-3 h-full" style={{ minWidth: `${cols.length * 284}px` }}>

          {cols.map((col) => {
            const colTasks = sortByPriority(visibleTasks.filter(t => t.status === col.id));
            const isAddingHere = showCardForm === col.id;
            const isDragOver   = dragOverCol === col.id && dragTaskId !== null;
            const pendingHere  = col.hitl && colTasks.length > 0;

            return (
              <div
                key={col.id}
                className={cn(
                  "flex flex-col rounded-xl border bg-card/50 shrink-0 transition-all duration-150",
                  isDragOver ? "border-primary/60 bg-primary/5 scale-[1.01]" : "border-border",
                  pendingHere && "border-amber-400/50 shadow-[0_0_0_1px_rgba(245,158,11,0.2)]"
                )}
                style={{ width: 276 }}
                onDragOver={e => onColDragOver(e, col.id)}
                onDragLeave={() => setDragOverCol(null)}
                onDrop={e => onColDrop(e, col.id)}
              >
                {/* Column header */}
                <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border shrink-0">
                  <div
                    className="w-2 h-2 rounded-full shrink-0 cursor-pointer"
                    style={{ background: col.color }}
                    onClick={() => updateColumn(col.id, { color: COLORS[(COLORS.indexOf(col.color) + 1) % COLORS.length] })}
                    title="Click to change color"
                  />
                  {editingCol === col.id ? (
                    <input
                      value={editColLabel}
                      onChange={e => setEditColLabel(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter") { updateColumn(col.id, { label: editColLabel }); setEditingCol(null); }
                        if (e.key === "Escape") setEditingCol(null);
                      }}
                      onBlur={() => { updateColumn(col.id, { label: editColLabel }); setEditingCol(null); }}
                      autoFocus
                      className="flex-1 bg-transparent text-xs font-semibold uppercase tracking-wider outline-none border-b border-primary"
                    />
                  ) : (
                    <button
                      className="flex-1 text-xs font-semibold uppercase tracking-wider truncate text-left hover:text-primary transition-colors"
                      onDoubleClick={() => { setEditingCol(col.id); setEditColLabel(col.label); }}
                      title="Double-click to rename"
                    >
                      {col.label}
                    </button>
                  )}
                  {col.hitl && (
                    <span className="text-[10px] text-amber-600 bg-amber-50 dark:bg-amber-950 dark:text-amber-400 rounded px-1.5 py-0.5 font-semibold flex items-center gap-0.5 shrink-0">
                      <Shield className="h-2.5 w-2.5" /> HITL
                    </span>
                  )}
                  <span className="text-xs font-bold text-muted-foreground shrink-0 tabular-nums">{colTasks.length}</span>
                  <button
                    className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => setShowCardForm(isAddingHere ? null : col.id)}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>

                {/* Inline card form */}
                {isAddingHere && (
                  <div className="p-3 border-b border-border space-y-2 bg-card shrink-0">
                    <input
                      value={cardForm.title}
                      onChange={e => setCardForm(f => ({ ...f, title: e.target.value }))}
                      onKeyDown={e => e.key === "Enter" && addTask(col.id)}
                      placeholder="Card title…"
                      autoFocus
                      className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:ring-2 focus:ring-primary/30"
                    />
                    <textarea
                      value={cardForm.description}
                      onChange={e => setCardForm(f => ({ ...f, description: e.target.value }))}
                      placeholder="Description (optional)…"
                      rows={2}
                      className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:ring-2 focus:ring-primary/30 resize-none"
                    />
                    {fields.includes("priority") && (
                      <select
                        value={cardForm.priority}
                        onChange={e => setCardForm(f => ({ ...f, priority: e.target.value }))}
                        className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-xs outline-none"
                      >
                        <option value="low">Low priority</option>
                        <option value="medium">Medium priority</option>
                        <option value="high">High priority</option>
                      </select>
                    )}
                    {fields.includes("due_date") && (
                      <input type="date" value={cardForm.due_date}
                        onChange={e => setCardForm(f => ({ ...f, due_date: e.target.value }))}
                        className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-xs outline-none" />
                    )}
                    {fields.includes("tags") && (
                      <input value={cardForm.tags}
                        onChange={e => setCardForm(f => ({ ...f, tags: e.target.value }))}
                        placeholder="Tags (comma separated)"
                        className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-xs outline-none" />
                    )}
                    {fields.includes("assignee") && (
                      <input value={cardForm.assignee}
                        onChange={e => setCardForm(f => ({ ...f, assignee: e.target.value }))}
                        placeholder="Assignee"
                        className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-xs outline-none" />
                    )}
                    {fields.includes("automation") && (
                      <input value={cardForm.automation}
                        onChange={e => setCardForm(f => ({ ...f, automation: e.target.value }))}
                        placeholder="Automation trigger"
                        className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-xs outline-none" />
                    )}
                    <div className="flex gap-1.5">
                      <Button size="sm" className="flex-1 h-7 text-xs" onClick={() => addTask(col.id)} disabled={!cardForm.title.trim()}>
                        Add card
                      </Button>
                      <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setShowCardForm(null)}>
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                )}

                {/* Cards */}
                <div className="flex-1 overflow-y-auto p-2 space-y-2">
                  {colTasks.map(task => {
                    const tags    = parseTags(task.tags);
                    const isOverdue = task.due_date && new Date(task.due_date) < new Date() && task.status !== lastColId;
                    const isDragging = dragTaskId === task.id;
                    return (
                      <div
                        key={task.id}
                        draggable={!col.hitl}
                        onDragStart={e => { if (col.hitl) { e.preventDefault(); return; } onCardDragStart(e, task.id); }}
                        onDragEnd={() => { setDragTaskId(null); setDragOverCol(null); }}
                        className={cn(
                          "rounded-lg border border-border bg-card p-3 shadow-sm hover:shadow-md cursor-grab active:cursor-grabbing transition-all group",
                          isDragging && "opacity-40 scale-95"
                        )}
                      >
                        {/* Title row */}
                        <div className="flex items-start justify-between gap-1.5 mb-1.5">
                          <p className="text-sm font-medium leading-snug flex-1 break-words">{task.title}</p>
                          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                            <button
                              onClick={() => openEdit(task)}
                              className="text-muted-foreground hover:text-foreground p-0.5 rounded"
                              title="Edit card"
                            >
                              <Pencil className="h-3 w-3" />
                            </button>
                            {/* Move to column dropdown */}
                            <div className="relative group/move">
                              <button className="text-muted-foreground hover:text-foreground p-0.5 rounded">
                                <MoreHorizontal className="h-3.5 w-3.5" />
                              </button>
                              <div className="absolute right-0 top-full mt-1 w-40 rounded-xl border border-border bg-card shadow-xl hidden group-hover/move:block z-30">
                                <div className="p-1">
                                  {cols.filter(c => c.id !== task.status && validateMove(cols, task.status, c.id).ok).map(c => (
                                    <button key={c.id} onClick={() => moveTask(task.id, c.id)}
                                      className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs rounded-lg hover:bg-secondary transition-colors">
                                      <div className="w-2 h-2 rounded-full shrink-0" style={{ background: c.color }} />
                                      {c.label}
                                    </button>
                                  ))}
                                  <div className="border-t border-border mt-1 pt-1">
                                    <button onClick={() => deleteTask(task.id)}
                                      className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs rounded-lg text-destructive hover:bg-secondary transition-colors">
                                      <Trash2 className="h-3 w-3" /> Delete
                                    </button>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* Description snippet */}
                        {task.description && (
                          <p className="text-[11px] text-muted-foreground mb-2 line-clamp-2 leading-relaxed">
                            {task.description}
                          </p>
                        )}

                        {/* Field badges */}
                        <div className="flex flex-wrap gap-1 mb-1.5">
                          {fields.includes("priority") && (
                            <span className={cn("text-[10px] font-medium rounded-full px-1.5 py-0.5 capitalize", PRIORITY_BADGE[task.priority])}>
                              {task.priority}
                            </span>
                          )}
                          {fields.includes("due_date") && task.due_date && (
                            <span className={cn("flex items-center gap-0.5 text-[10px] rounded-full px-1.5 py-0.5",
                              isOverdue ? "bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-400" : "bg-secondary text-muted-foreground"
                            )}>
                              <Calendar className="h-2.5 w-2.5" />
                              {new Date(task.due_date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                              {isOverdue && " ⚠"}
                            </span>
                          )}
                          {fields.includes("assignee") && task.assignee && (
                            <span className="flex items-center gap-0.5 text-[10px] bg-secondary text-muted-foreground rounded-full px-1.5 py-0.5">
                              <User className="h-2.5 w-2.5" /> {task.assignee}
                            </span>
                          )}
                          {fields.includes("automation") && task.automation && (
                            <span className="flex items-center gap-0.5 text-[10px] bg-primary/10 text-primary rounded-full px-1.5 py-0.5">
                              <Zap className="h-2.5 w-2.5" /> {task.automation}
                            </span>
                          )}
                        </div>
                        {fields.includes("tags") && tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 mb-1.5">
                            {tags.map((tag: string) => (
                              <span key={tag} className="flex items-center gap-0.5 text-[10px] bg-accent text-accent-foreground rounded px-1.5 py-0.5">
                                <Tag className="h-2 w-2" /> {tag}
                              </span>
                            ))}
                          </div>
                        )}

                        <div className="flex items-center justify-between">
                          <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                            <Clock className="h-2.5 w-2.5" /> {timeAgo(task.created_at)}
                          </span>
                          {task.approved_at && (
                            <span className="text-[10px] text-green-600 dark:text-green-400 flex items-center gap-0.5">
                              <CheckCircle2 className="h-2.5 w-2.5" /> Approved {timeAgo(task.approved_at)}
                            </span>
                          )}
                        </div>

                        {/* HITL gate notice */}
                        {col.hitl && (
                          <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-1.5 flex items-center gap-1">
                            <Shield className="h-2.5 w-2.5 shrink-0" />
                            Human approval required — automations pause here
                          </p>
                        )}

                        {/* HITL buttons */}
                        {col.hitl && (
                          <div className="flex gap-1.5 mt-2 pt-2 border-t border-border">
                            <button onClick={() => approve(task.id)}
                              className="flex items-center justify-center gap-1 text-[10px] font-medium text-green-700 bg-green-50 dark:bg-green-950 dark:text-green-400 rounded-lg px-2 py-1.5 hover:opacity-80 transition-opacity flex-1">
                              <CheckCircle2 className="h-3 w-3" /> Approve
                            </button>
                            <button onClick={() => promptReject(task)}
                              className="flex items-center justify-center gap-1 text-[10px] font-medium text-red-700 bg-red-50 dark:bg-red-950 dark:text-red-400 rounded-lg px-2 py-1.5 hover:opacity-80 transition-opacity flex-1">
                              <XCircle className="h-3 w-3" /> Reject
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {colTasks.length === 0 && !isAddingHere && (
                    <button
                      onClick={() => setShowCardForm(col.id)}
                      className={cn(
                        "w-full flex items-center justify-center gap-1 h-16 rounded-lg border-2 border-dashed text-xs transition-colors",
                        isDragOver ? "border-primary text-primary" : "border-border text-muted-foreground hover:border-primary/40 hover:text-primary"
                      )}
                    >
                      <Plus className="h-3 w-3" />
                      {isDragOver ? "Drop here" : "Add card"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {/* Add column */}
          <button
            onClick={addColumn}
            className="flex items-center gap-1.5 rounded-xl border-2 border-dashed border-border px-5 py-3 text-xs text-muted-foreground hover:border-primary/40 hover:text-primary transition-colors h-fit shrink-0 self-start"
          >
            <Plus className="h-3.5 w-3.5" /> Add column
          </button>
        </div>
      </div>

      {/* ── Card Edit Modal ─────────────────────────────────────────────── */}
      {editTask && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setEditTask(null)}>
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
          <div className="relative bg-card rounded-2xl border border-border shadow-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-semibold text-base">Edit Card</h2>
              <button onClick={() => setEditTask(null)} className="text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">Title</label>
                <input
                  value={editForm.title}
                  onChange={e => setEditForm(f => ({ ...f, title: e.target.value }))}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                  autoFocus
                />
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">Description</label>
                <textarea
                  value={editForm.description}
                  onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="Add more context, acceptance criteria, links…"
                  rows={3}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30 resize-none"
                />
              </div>

              {/* Column / HITL */}
              {(() => {
                const currentCol = cols.find(c => c.id === editTask.status);
                if (currentCol?.hitl) {
                  return (
                    <div className="rounded-lg border border-amber-300/50 bg-amber-50 dark:bg-amber-950/30 p-3 space-y-2">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-400">
                        <Shield className="h-3.5 w-3.5" /> HITL gate — {currentCol.label}
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        This card is waiting for human approval. Automations are paused until you approve.
                      </p>
                      <div className="flex gap-2">
                        <Button size="sm" className="flex-1 h-8 text-xs" onClick={() => approve(editTask.id)}>
                          <CheckCircle2 className="h-3 w-3" /> Approve
                        </Button>
                        <Button size="sm" variant="outline" className="flex-1 h-8 text-xs text-destructive" onClick={() => promptReject(editTask)}>
                          <XCircle className="h-3 w-3" /> Reject
                        </Button>
                      </div>
                    </div>
                  );
                }
                return (
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1">Column</label>
                    <select
                      value={editTask.status}
                      onChange={e => { moveTask(editTask.id, e.target.value); setEditTask(t => t ? { ...t, status: e.target.value } : t); }}
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none"
                    >
                      {cols.map(c => {
                        const blocked = !validateMove(cols, editTask.status, c.id).ok && c.id !== editTask.status;
                        return (
                          <option key={c.id} value={c.id} disabled={blocked}>
                            {c.label}{blocked ? " (HITL — use Approve)" : ""}
                          </option>
                        );
                      })}
                    </select>
                  </div>
                );
              })()}

              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">Priority</label>
                <select value={editForm.priority} onChange={e => setEditForm(f => ({ ...f, priority: e.target.value }))}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none">
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">Due Date</label>
                <input type="date" value={editForm.due_date} onChange={e => setEditForm(f => ({ ...f, due_date: e.target.value }))}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none" />
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">Assignee</label>
                <input value={editForm.assignee} onChange={e => setEditForm(f => ({ ...f, assignee: e.target.value }))}
                  placeholder="Name or @handle"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none" />
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">Tags (comma separated)</label>
                <input value={editForm.tags} onChange={e => setEditForm(f => ({ ...f, tags: e.target.value }))}
                  placeholder="design, urgent, v2"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none" />
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">
                  Automation Label
                  <span className="ml-1.5 text-[10px] bg-primary/10 text-primary rounded-full px-1.5 py-0.5">optional</span>
                </label>
                <p className="text-[11px] text-muted-foreground mb-1.5">
                  Links this card to <strong className="text-foreground">AI Automations</strong>. Automations fire only after HITL approval or when moving between normal columns — not while waiting in a HITL gate.
                </p>
                <input value={editForm.automation} onChange={e => setEditForm(f => ({ ...f, automation: e.target.value }))}
                  placeholder="e.g. notify-slack, send-invoice, run-tests"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none" />
              </div>

              {/* Activity timeline */}
              <div className="border-t border-border pt-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground mb-2">
                  <History className="h-3.5 w-3.5" /> Activity
                </div>
                {activityLoading ? (
                  <p className="text-xs text-muted-foreground">Loading…</p>
                ) : activity.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No activity yet.</p>
                ) : (
                  <ul className="space-y-2 max-h-36 overflow-y-auto">
                    {activity.map((a, i) => (
                      <li key={i} className="text-xs flex gap-2">
                        <span className="text-muted-foreground shrink-0 tabular-nums">{timeAgo(a.created_at)}</span>
                        <span>
                          <strong className="capitalize">{a.action}</strong>
                          {a.details.from != null && a.details.to != null && (
                            <span className="text-muted-foreground"> · {String(a.details.from)} → {String(a.details.to)}</span>
                          )}
                          {a.details.reason != null && (
                            <span className="text-muted-foreground"> · {String(a.details.reason)}</span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 mt-6">
              <Button className="flex-1" onClick={saveEdit} disabled={editSaving}>
                {editSaving ? <div className="h-3.5 w-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                Save changes
              </Button>
              <Button variant="destructive" size="sm" onClick={() => deleteTask(editTask.id)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Reject reason modal ─────────────────────────────────────────── */}
      {rejectTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" onClick={() => setRejectTarget(null)}>
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
          <div className="relative bg-card rounded-2xl border border-border shadow-2xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
            <h2 className="font-semibold mb-1">Reject card</h2>
            <p className="text-xs text-muted-foreground mb-4">
              &ldquo;{rejectTarget.title}&rdquo; will be removed. Optionally add a reason (logged in activity).
            </p>
            <textarea
              value={rejectReason}
              onChange={e => setRejectReason(e.target.value)}
              placeholder="Reason for rejection (optional)…"
              rows={3}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none resize-none mb-4"
              autoFocus
            />
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setRejectTarget(null)}>Cancel</Button>
              <Button variant="destructive" className="flex-1" onClick={confirmReject}>
                <XCircle className="h-3.5 w-3.5" /> Reject
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Settings Drawer ─────────────────────────────────────────────── */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex" onClick={() => setShowSettings(false)}>
          <div className="flex-1 bg-black/30 backdrop-blur-sm" />
          <div className="h-full w-full max-w-[400px] overflow-y-auto border-l border-border bg-card shadow-2xl sm:w-[min(400px,92vw)]" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-border sticky top-0 bg-card z-10">
              <div>
                <h2 className="font-semibold">Board Settings</h2>
                <p className="text-xs text-muted-foreground">Customize columns, fields, and layout</p>
              </div>
              <button onClick={() => setShowSettings(false)}><X className="h-4 w-4 text-muted-foreground" /></button>
            </div>

            <div className="p-5 space-y-7">
              {/* Board name */}
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground block mb-2">Board Name</label>
                <input
                  value={boardName}
                  onChange={e => handleBoardNameChange(e.target.value)}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>

              {/* Template picker */}
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground block mb-2">Apply Template</label>
                <div className="space-y-1.5">
                  {Object.entries(TEMPLATES).map(([id, tmpl]) => (
                    <button key={id} onClick={() => applyTemplate(id)}
                      className={cn("w-full text-left rounded-lg border px-3 py-2 text-sm transition-colors",
                        config?.template === id ? "border-primary bg-primary/10 text-primary font-medium" : "border-border hover:border-primary/30"
                      )}>
                      {tmpl.label}
                      <span className="text-xs text-muted-foreground ml-2">({tmpl.columns.length} cols)</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Columns */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Columns</label>
                  <button onClick={addColumn} className="text-xs text-primary hover:underline flex items-center gap-1">
                    <Plus className="h-3 w-3" /> Add
                  </button>
                </div>
                <p className="text-xs text-muted-foreground mb-3">Drag to reorder · Click color dot to cycle · Click shield to toggle HITL</p>
                <div className="space-y-2">
                  {cols.map((col, idx) => (
                    <div key={col.id}
                      draggable={editingCol !== col.id}
                      onDragStart={() => editingCol !== col.id && onColHeaderDragStart(idx)}
                      onDragOver={e => onColHeaderDragOver(e, idx)}
                      onDrop={() => onColHeaderDrop(idx)}
                      onDragEnd={() => { setDragColIdx(null); setOverColIdx(null); }}
                      className={cn(
                        "flex items-center gap-2 rounded-lg border bg-background px-3 py-2 transition-colors",
                        editingCol === col.id ? "cursor-text" : "cursor-grab",
                        overColIdx === idx && dragColIdx !== null ? "border-primary bg-primary/5" : "border-border"
                      )}
                    >
                      {/* Grip — only shows when not editing */}
                      <GripVertical className={cn("h-3.5 w-3.5 text-muted-foreground shrink-0", editingCol === col.id && "invisible")} />
                      <div
                        className="w-3.5 h-3.5 rounded-full shrink-0 cursor-pointer ring-1 ring-border hover:ring-primary transition-all"
                        style={{ background: col.color }}
                        onMouseDown={e => e.stopPropagation()}
                        onClick={() => updateColumn(col.id, { color: COLORS[(COLORS.indexOf(col.color) + 1) % COLORS.length] })}
                        title="Click to change color"
                      />
                      {editingCol === col.id ? (
                        <input
                          value={editColLabel}
                          onChange={e => setEditColLabel(e.target.value)}
                          onMouseDown={e => e.stopPropagation()}
                          onKeyDown={e => {
                            e.stopPropagation();
                            if (e.key === "Enter") { updateColumn(col.id, { label: editColLabel || col.label }); setEditingCol(null); }
                            if (e.key === "Escape") setEditingCol(null);
                          }}
                          onBlur={() => { updateColumn(col.id, { label: editColLabel || col.label }); setEditingCol(null); }}
                          autoFocus
                          className="flex-1 bg-transparent text-sm outline-none border-b-2 border-primary py-0.5"
                        />
                      ) : (
                        <span
                          className="flex-1 text-sm truncate"
                          onDoubleClick={() => { setEditingCol(col.id); setEditColLabel(col.label); }}
                          title="Double-click to rename"
                        >
                          {col.label}
                        </span>
                      )}
                      <button
                        onMouseDown={e => e.stopPropagation()}
                        onClick={() => updateColumn(col.id, { hitl: !col.hitl })}
                        title={col.hitl ? "HITL on — click to remove" : "Click to add HITL approval gate"}
                        className={cn("flex items-center gap-0.5 text-[10px] rounded px-1.5 py-0.5 shrink-0 font-semibold transition-colors",
                          col.hitl ? "bg-amber-50 text-amber-600 dark:bg-amber-950 dark:text-amber-400" : "bg-secondary text-muted-foreground hover:bg-amber-50 hover:text-amber-600"
                        )}
                      >
                        <Shield className="h-2.5 w-2.5" />
                      </button>
                      <button
                        onMouseDown={e => e.stopPropagation()}
                        onClick={() => { setEditingCol(col.id); setEditColLabel(col.label); }}
                        className="text-muted-foreground hover:text-foreground shrink-0"
                        title="Rename column"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        onMouseDown={e => e.stopPropagation()}
                        onClick={() => deleteColumn(col.id)}
                        className="text-muted-foreground hover:text-destructive shrink-0"
                        title="Delete column"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Card fields */}
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground block mb-2">Card Fields</label>
                <p className="text-xs text-muted-foreground mb-3">Toggle which fields appear on cards and in the add form.</p>
                <div className="space-y-1.5">
                  {([
                    { key: "priority"   as CardField, icon: ChevronDown, label: "Priority" },
                    { key: "due_date"   as CardField, icon: Calendar,    label: "Due Date" },
                    { key: "tags"       as CardField, icon: Tag,         label: "Tags" },
                    { key: "assignee"   as CardField, icon: User,        label: "Assignee" },
                    { key: "automation" as CardField, icon: Zap,         label: "Automation Label" },
                  ]).map(({ key, icon: Icon, label }) => (
                    <button key={key} onClick={() => toggleField(key)}
                      className={cn("w-full flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
                        fields.includes(key) ? "border-primary bg-primary/10 text-primary" : "border-border hover:border-primary/30"
                      )}>
                      <Icon className="h-3.5 w-3.5 shrink-0" />
                      <span className="flex-1 text-left">{label}</span>
                      {fields.includes(key) && <CheckCircle2 className="h-3.5 w-3.5 text-primary shrink-0" />}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
