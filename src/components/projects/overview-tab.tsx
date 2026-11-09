"use client";

import { useState } from "react";
import { Plus, Trash2, UserPlus } from "lucide-react";
import type { Notice, ProjectDetail } from "./types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Banner, Empty } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { Checkbox, Input, Select } from "@/components/ui/input";
import { Pill } from "@/components/ui/pill";
import { fmtMoney } from "@/lib/money/format";
import { PROJECT_MEMBER_ROLES, type MilestoneDTO, type ProjectMemberDTO, type ProjectMemberRole } from "@/lib/projects/pure";
import { cn } from "@/lib/utils";
import { cap, fmtDay, hours, jsonFetch, memberLabel, type MemberOption } from "./shared";

export function OverviewTab({ detail, members, reload, notify }: { detail: ProjectDetail; members: MemberOption[]; reload: () => Promise<void>; notify: (tone: Notice["tone"], text: string) => void }) {
  const { project, progress, budget, milestones } = detail;
  const [newMilestone, setNewMilestone] = useState(false);
  const [addMember, setAddMember] = useState(false);
  const readOnly = Boolean(project.archived_at);

  async function toggleMilestone(m: MilestoneDTO) {
    try {
      await jsonFetch(`/api/projects/milestones/${encodeURIComponent(m.id)}`, { method: "PATCH", body: JSON.stringify({ status: m.status === "done" ? "open" : "done" }), fallback: "Could not update milestone" });
      notify("success", m.status === "done" ? `Reopened ${m.name}.` : `Completed ${m.name}.`);
      await reload();
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Could not update milestone");
    }
  }
  async function removeMilestone(m: MilestoneDTO) {
    if (!window.confirm(`Delete milestone "${m.name}"? Tasks linked to it are kept.`)) return;
    try {
      await jsonFetch(`/api/projects/milestones/${encodeURIComponent(m.id)}`, { method: "DELETE", fallback: "Could not delete milestone" });
      await reload();
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Could not delete milestone");
    }
  }
  async function removeMember(mem: ProjectMemberDTO) {
    try {
      await jsonFetch(`/api/projects/${encodeURIComponent(project.id)}/members?id=${encodeURIComponent(mem.id)}`, { method: "DELETE", fallback: "Could not remove member" });
      await reload();
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Could not remove member");
    }
  }

  const daysLabel =
    progress.days_remaining === null ? "No due date" : progress.days_remaining < 0 ? `${Math.abs(progress.days_remaining)} days late` : progress.days_remaining === 0 ? "Due today" : `${progress.days_remaining} days left`;
  const burn = budget.burn_pct ?? 0;

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {/* Progress */}
      <section className="rounded-xl border border-border bg-card p-4 lg:col-span-2" aria-labelledby="progress-h">
        <h2 id="progress-h" className="mb-3 text-base font-semibold">
          Progress
        </h2>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Tasks done" value={`${progress.tasks_done}/${progress.tasks_total}`} hint={`${progress.percent}%`} />
          <Stat label="Overdue" value={String(progress.overdue_tasks)} tone={progress.overdue_tasks > 0 ? "danger" : undefined} />
          <Stat label="Milestones" value={`${progress.milestones_done}/${progress.milestones_total}`} hint={progress.next_milestone ? `Next: ${progress.next_milestone.name}` : undefined} />
          <Stat label="Deadline" value={daysLabel} tone={progress.days_remaining !== null && progress.days_remaining < 0 && project.status !== "done" ? "danger" : undefined} hint={project.due_on ? fmtDay(project.due_on) : undefined} />
        </dl>
        <div className="mt-4">
          <div className="mb-1 flex justify-between text-xs text-muted-foreground">
            <span>Tasks</span>
            <span className="tabular-nums">{progress.percent}%</span>
          </div>
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuenow={progress.percent} aria-valuemin={0} aria-valuemax={100} aria-label="Tasks done">
            <div className="h-full rounded-full bg-primary transition-[width] motion-reduce:transition-none" style={{ width: `${progress.percent}%` }} />
          </div>
          {progress.estimate_minutes_total > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              {hours(progress.estimate_minutes_remaining)} of {hours(progress.estimate_minutes_total)} estimated work remaining.
            </p>
          )}
        </div>
        {project.description_md && <p className="mt-4 whitespace-pre-wrap text-sm text-muted-foreground">{project.description_md}</p>}
      </section>

      {/* Budget */}
      <section className="rounded-xl border border-border bg-card p-4" aria-labelledby="budget-h">
        <h2 id="budget-h" className="mb-3 text-base font-semibold">
          Budget vs actual
        </h2>
        {project.budget_minor === 0 && budget.actual_minor === 0 ? (
          <p className="text-sm text-muted-foreground">No budget set and nothing logged yet. Edit the project to add a budget, or log time and expenses under Time &amp; costs.</p>
        ) : (
          <>
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-2xl font-semibold tabular-nums">{fmtMoney(budget.actual_minor, budget.currency)}</span>
              <span className="text-xs text-muted-foreground">of {project.budget_minor > 0 ? fmtMoney(budget.budget_minor, budget.currency) : "no budget"}</span>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuenow={Math.min(100, Math.round(burn))} aria-valuemin={0} aria-valuemax={100} aria-label="Budget used">
              <div className={cn("h-full rounded-full", budget.over_budget ? "bg-red-500" : burn > 85 ? "bg-amber-500" : "bg-emerald-500")} style={{ width: `${Math.min(100, burn)}%` }} />
            </div>
            <p className={cn("mt-1 text-xs", budget.over_budget ? "font-medium text-red-600 dark:text-red-400" : "text-muted-foreground")}>
              {budget.burn_pct === null ? "No budget to compare" : budget.over_budget ? `Over budget by ${fmtMoney(-budget.remaining_minor, budget.currency)}` : `${budget.burn_pct}% used · ${fmtMoney(budget.remaining_minor, budget.currency)} left`}
            </p>
            <dl className="mt-4 space-y-2 text-sm">
              <Row label={`Time (${hours(budget.time_minutes)})`} value={fmtMoney(budget.time_minor, budget.currency)} total={budget.actual_minor} part={budget.time_minor} color="bg-sky-500" />
              <Row label="Expenses" value={fmtMoney(budget.expense_minor, budget.currency)} total={budget.actual_minor} part={budget.expense_minor} color="bg-amber-500" />
              <Row label="Stock used" value={fmtMoney(budget.stock_minor, budget.currency)} total={budget.actual_minor} part={budget.stock_minor} color="bg-violet-500" />
            </dl>
            {(budget.billed_minor > 0 || budget.paid_minor > 0) && (
              <p className="mt-3 text-xs text-muted-foreground">
                Billed {fmtMoney(budget.billed_minor, budget.currency)} · paid {fmtMoney(budget.paid_minor, budget.currency)}
              </p>
            )}
          </>
        )}
      </section>

      {/* Milestones */}
      <section className="rounded-xl border border-border bg-card p-4 lg:col-span-2" aria-labelledby="milestones-h">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 id="milestones-h" className="text-base font-semibold">
            Milestones
          </h2>
          {!readOnly && (
            <Button size="sm" variant="outline" touch onClick={() => setNewMilestone(true)}>
              <Plus className="h-4 w-4" aria-hidden /> Add milestone
            </Button>
          )}
        </div>
        {milestones.length === 0 ? (
          <Empty
            title="No milestones"
            text="Break the project into a few checkpoints with due dates."
            action={
              !readOnly ? (
                <Button size="sm" variant="outline" touch onClick={() => setNewMilestone(true)}>
                  <Plus className="h-4 w-4" aria-hidden /> Add milestone
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {milestones.map((m) => {
              const late = m.status !== "done" && m.due_on !== null && m.due_on < new Date().toISOString().slice(0, 10);
              return (
                <li key={m.id} className="flex items-center gap-3 px-3 py-2">
                  <Checkbox label={<span className="sr-only">Mark {m.name} {m.status === "done" ? "open" : "done"}</span>} checked={m.status === "done"} onChange={() => void toggleMilestone(m)} disabled={readOnly} />
                  <span className={cn("min-w-0 flex-1 break-words text-sm", m.status === "done" && "text-muted-foreground line-through")}>{m.name}</span>
                  <span className={cn("shrink-0 text-xs tabular-nums", late ? "font-medium text-red-600 dark:text-red-400" : "text-muted-foreground")}>{m.due_on ? fmtDay(m.due_on) : "No date"}</span>
                  {!readOnly && (
                    <Button size="icon-sm" variant="ghost" touch onClick={() => void removeMilestone(m)} aria-label={`Delete ${m.name}`}>
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Members */}
      <section className="rounded-xl border border-border bg-card p-4" aria-labelledby="members-h">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 id="members-h" className="text-base font-semibold">
            Team
          </h2>
          {!readOnly && (
            <Button size="sm" variant="outline" touch onClick={() => setAddMember(true)}>
              <UserPlus className="h-4 w-4" aria-hidden /> Add member
            </Button>
          )}
        </div>
        <p className="mb-2 text-xs text-muted-foreground">Owner: {memberLabel(members, project.owner_member_id)}</p>
        {detail.members.length === 0 ? (
          <p className="text-sm text-muted-foreground">No members yet. Membership is informational — org roles decide access.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {detail.members.map((mem) => (
              <li key={mem.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{mem.member_user_id ? memberLabel(members, mem.member_user_id) : `Staff ${mem.staff_id?.slice(0, 8)}…`}</span>
                <Pill>{cap(mem.role)}</Pill>
                {!readOnly && (
                  <Button size="icon-sm" variant="ghost" touch onClick={() => void removeMember(mem)} aria-label={`Remove ${mem.member_user_id ? memberLabel(members, mem.member_user_id) : "member"}`}>
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {newMilestone && (
        <MilestoneDialog
          projectId={project.id}
          onClose={() => setNewMilestone(false)}
          onSaved={() => {
            setNewMilestone(false);
            void reload();
          }}
        />
      )}
      {addMember && (
        <MemberDialog
          projectId={project.id}
          members={members}
          onClose={() => setAddMember(false)}
          onSaved={() => {
            setAddMember(false);
            void reload();
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "danger" }) {
  return (
    <div className="rounded-lg bg-secondary/40 p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("text-lg font-semibold tabular-nums", tone === "danger" && "text-red-600 dark:text-red-400")}>{value}</dd>
      {hint && <dd className="truncate text-xs text-muted-foreground">{hint}</dd>}
    </div>
  );
}

function Row({ label, value, total, part, color }: { label: string; value: string; total: number; part: number; color: string }) {
  const pct = total > 0 ? Math.round((part / total) * 100) : 0;
  return (
    <div>
      <div className="flex justify-between">
        <dt className="text-muted-foreground">{label}</dt>
        <dd className="tabular-nums">{value}</dd>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-secondary" aria-hidden>
        <div className={cn("h-full rounded-full", color)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function MilestoneDialog({ projectId, onClose, onSaved }: { projectId: string; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await jsonFetch(`/api/projects/${encodeURIComponent(projectId)}/milestones`, { method: "POST", body: JSON.stringify({ name: name.trim(), due_on: dueOn || null }), fallback: "Could not add milestone" });
      onSaved();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not add milestone");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="Add milestone" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {err && (
          <Banner tone="error" onDismiss={() => setErr(null)}>
            {err}
          </Banner>
        )}
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} autoFocus />
        </Field>
        <Field label="Due">
          <Input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" touch onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" touch disabled={busy}>
            {busy ? "Adding…" : "Add milestone"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function MemberDialog({ projectId, members, onClose, onSaved }: { projectId: string; members: MemberOption[]; onClose: () => void; onSaved: () => void }) {
  const [memberId, setMemberId] = useState(members[0]?.id ?? "");
  const [role, setRole] = useState<ProjectMemberRole>("member");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await jsonFetch(`/api/projects/${encodeURIComponent(projectId)}/members`, { method: "POST", body: JSON.stringify({ member_user_id: memberId, role }), fallback: "Could not add member" });
      onSaved();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not add member");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="Add team member" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {err && (
          <Banner tone="error" onDismiss={() => setErr(null)}>
            {err}
          </Banner>
        )}
        <Field label="Member" required hint={members.length === 0 ? "No team members visible — invite people under Settings → Team." : undefined}>
          <Select value={memberId} onChange={(e) => setMemberId(e.target.value)} required>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Role">
          <Select value={role} onChange={(e) => setRole(e.target.value as ProjectMemberRole)}>
            {PROJECT_MEMBER_ROLES.map((r) => (
              <option key={r} value={r}>
                {cap(r)}
              </option>
            ))}
          </Select>
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" touch onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" touch disabled={busy || !memberId}>
            {busy ? "Adding…" : "Add"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
