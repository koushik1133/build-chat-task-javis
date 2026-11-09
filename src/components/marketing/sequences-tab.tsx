"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowDown, GitBranch, Loader2, Pause, Play, Plus, Trash2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, Drawer } from "@/components/ui/dialog";
import { Empty, ErrorState, SkeletonList } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Pill, StatusPill } from "@/components/ui/pill";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { timeAgo } from "@/lib/utils";
import type { EnrollmentWithContact, SequenceRow } from "@/lib/marketing/sequences";
import type { AudienceRow } from "@/lib/marketing/audiences";
import type { TemplateRow } from "@/lib/marketing/templates";
import { parseSteps, parseTriggerConfig, type SequenceStep, type SequenceTrigger } from "@/lib/marketing/types";
import { ENROLLMENT_TONE, jsonFetch, type Notice } from "./shared";

type SeqListRow = SequenceRow & { active: number; done: number; exited: number };

const TRIGGER_LABEL: Record<SequenceTrigger, string> = { manual: "Manual enrollment", audience_join: "When a contact joins an audience", event: "From an automation (lead captured, …)" };

export function SequencesTab({ notify }: { notify: (tone: Notice["tone"], text: string) => void }) {
  const [rows, setRows] = useState<SeqListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [open, setOpen] = useState<SeqListRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows((await jsonFetch<{ sequences: SeqListRow[] }>("/api/marketing/sequences", undefined, "Could not load sequences")).sequences);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load sequences");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(s: SeqListRow) {
    try {
      await jsonFetch(`/api/marketing/sequences/${s.id}`, { method: "PATCH", body: JSON.stringify({ status: s.status === "active" ? "paused" : "active" }) }, "Could not update");
      notify("success", s.status === "active" ? "Sequence paused — no steps will send." : "Sequence resumed.");
      void load();
    } catch (e) {
      notify("error", e instanceof Error ? e.message : "Could not update");
    }
  }
  async function remove(s: SeqListRow) {
    if (!window.confirm(`Delete sequence "${s.name}" and its enrollments?`)) return;
    try {
      await jsonFetch(`/api/marketing/sequences/${s.id}`, { method: "DELETE" }, "Could not delete");
      notify("success", "Sequence deleted.");
      void load();
    } catch (e) {
      notify("error", e instanceof Error ? e.message : "Could not delete");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">Timed drips. Each step is consent-checked when it is due; contacts exit when they reply or unsubscribe.</p>
        <Button type="button" touch className="self-start sm:self-auto" onClick={() => setShowNew(true)}>
          <Plus className="h-4 w-4" aria-hidden /> New sequence
        </Button>
      </div>
      {loading ? (
        <SkeletonList count={3} label="Loading sequences…" />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : rows.length === 0 ? (
        <Empty icon={<GitBranch className="h-5 w-5" />} title="No sequences yet" text="Create a welcome drip and enroll contacts manually, by audience, or from an automation." action={<Button type="button" touch onClick={() => setShowNew(true)}>Create a sequence</Button>} />
      ) : (
        <ul className="space-y-2" aria-label="Sequences">
          {rows.map((s) => {
            const steps = parseSteps(s.steps);
            return (
              <li key={s.id} className="rounded-lg border border-border bg-card p-3 sm:p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <button type="button" onClick={() => setOpen(s)} aria-label={`Open sequence ${s.name}`} className="min-w-0 touch-manipulation rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <p className="truncate font-medium underline-offset-2 hover:underline">{s.name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {steps.length} step{steps.length === 1 ? "" : "s"} · {TRIGGER_LABEL[s.trigger]}
                    </p>
                  </button>
                  <div className="flex items-center gap-1.5">
                    <StatusPill status={s.status} map={{ active: "success", paused: "warning" }} />
                    <Button type="button" variant="ghost" size="icon-sm" touch aria-label={s.status === "active" ? "Pause sequence" : "Resume sequence"} onClick={() => toggle(s)}>
                      {s.status === "active" ? <Pause className="h-3.5 w-3.5" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
                    </Button>
                    <Button type="button" variant="ghost" size="icon-sm" touch aria-label="Delete sequence" onClick={() => remove(s)} className="text-destructive hover:text-destructive">
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                  <Pill tone="info">{s.active} active</Pill>
                  <Pill tone="success">{s.done} completed</Pill>
                  <Pill tone="warning">{s.exited} exited</Pill>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {showNew && (
        <SequenceDialog
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            notify("success", "Sequence created.");
            void load();
          }}
        />
      )}
      {open && (
        <SequenceDrawer
          sequence={open}
          onClose={() => setOpen(null)}
          notify={notify}
          onChanged={() => {
            void load();
          }}
        />
      )}
    </div>
  );
}

const EMPTY_STEP: SequenceStep = { delay_hours: 0, channel: "email", template_id: null, subject: "", body_md: "" };

function SequenceDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState<SequenceTrigger>("manual");
  const [audienceId, setAudienceId] = useState("");
  const [steps, setSteps] = useState<SequenceStep[]>([{ ...EMPTY_STEP }]);
  const [audiences, setAudiences] = useState<AudienceRow[]>([]);
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([jsonFetch<{ audiences: AudienceRow[] }>("/api/marketing/audiences"), jsonFetch<{ templates: TemplateRow[] }>("/api/marketing/templates")])
      .then(([a, t]) => {
        setAudiences(a.audiences);
        setTemplates(t.templates);
      })
      .catch(() => undefined);
  }, []);

  const setStep = (i: number, patch: Partial<SequenceStep>) => setSteps((s) => s.map((st, idx) => (idx === i ? { ...st, ...patch } : st)));

  async function save() {
    if (!name.trim()) return setErr("Name the sequence.");
    if (trigger === "audience_join" && !audienceId) return setErr("Pick the audience that triggers enrollment.");
    for (const [i, st] of steps.entries()) {
      if (!st.template_id && !st.body_md?.trim()) return setErr(`Step ${i + 1} needs a template or a message.`);
      if (st.channel === "email" && !st.template_id && !st.subject?.trim()) return setErr(`Step ${i + 1} needs a subject.`);
    }
    setBusy(true);
    setErr(null);
    try {
      await jsonFetch(
        "/api/marketing/sequences",
        {
          method: "POST",
          body: JSON.stringify({
            name: name.trim(),
            trigger,
            trigger_config: trigger === "audience_join" ? { audience_id: audienceId } : trigger === "event" ? { event_type: "lead.captured" } : {},
            steps: steps.map((s) => ({ delay_hours: s.delay_hours, channel: s.channel, template_id: s.template_id || null, subject: s.subject || null, body_md: s.body_md || null })),
          }),
        },
        "Could not create the sequence"
      );
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not create the sequence");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="New sequence" description="Steps run in order; the delay is measured from the previous step." onClose={onClose} size="lg">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="space-y-4"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" required hint='Name it "Welcome" to use the ready-made "New lead → welcome sequence" automation.'>
            <Input value={name} onChange={(e) => setName(e.target.value.slice(0, 120))} autoFocus placeholder="Welcome" />
          </Field>
          <Field label="Trigger">
            <Select value={trigger} onChange={(e) => setTrigger(e.target.value as SequenceTrigger)}>
              {(Object.keys(TRIGGER_LABEL) as SequenceTrigger[]).map((t) => (
                <option key={t} value={t}>
                  {TRIGGER_LABEL[t]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {trigger === "audience_join" && (
          <Field label="Audience" required hint="Contacts are enrolled by a background sweep as they match the audience.">
            <Select value={audienceId} onChange={(e) => setAudienceId(e.target.value)}>
              <option value="">Choose…</option>
              {audiences.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {trigger === "event" && <p className="text-xs text-muted-foreground">Install the “New lead → enroll in the welcome sequence” template under Automations, or add a step calling the marketing.enroll tool to any automation.</p>}

        <ol className="space-y-3" aria-label="Steps">
          {steps.map((st, i) => (
            <li key={i} className="rounded-lg border border-border p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-sm font-medium">Step {i + 1}</p>
                {steps.length > 1 && (
                  <Button type="button" variant="ghost" size="icon-sm" touch aria-label={`Remove step ${i + 1}`} onClick={() => setSteps((s) => s.filter((_, idx) => idx !== i))}>
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label={i === 0 ? "Wait before first step (hours)" : "Wait after previous step (hours)"}>
                  <Input type="number" min={0} max={8760} value={st.delay_hours} onChange={(e) => setStep(i, { delay_hours: Math.max(0, Math.min(8760, Number(e.target.value) || 0)) })} />
                </Field>
                <Field label="Channel">
                  <Select value={st.channel} onChange={(e) => setStep(i, { channel: e.target.value as SequenceStep["channel"] })}>
                    <option value="email">Email</option>
                    <option value="sms">SMS</option>
                  </Select>
                </Field>
                <Field label="Template">
                  <Select value={st.template_id ?? ""} onChange={(e) => setStep(i, { template_id: e.target.value || null })}>
                    <option value="">Compose below</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              {!st.template_id && (
                <div className="mt-3 space-y-3">
                  {st.channel === "email" && (
                    <Field label="Subject" required>
                      <Input value={st.subject ?? ""} onChange={(e) => setStep(i, { subject: e.target.value.slice(0, 300) })} />
                    </Field>
                  )}
                  <Field label="Message (markdown, merge fields allowed)" required>
                    <Textarea rows={4} value={st.body_md ?? ""} onChange={(e) => setStep(i, { body_md: e.target.value.slice(0, 20_000) })} className="font-mono text-xs" />
                  </Field>
                </div>
              )}
              {i < steps.length - 1 && <ArrowDown className="mx-auto mt-2 h-4 w-4 text-muted-foreground" aria-hidden />}
            </li>
          ))}
        </ol>
        <Button type="button" variant="outline" size="sm" touch disabled={steps.length >= 20} onClick={() => setSteps((s) => [...s, { ...EMPTY_STEP, delay_hours: 48 }])}>
          <Plus className="h-3.5 w-3.5" aria-hidden /> Add step
        </Button>
        {err && (
          <p role="alert" className="text-sm text-destructive">
            {err}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" touch onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" touch disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />} Create sequence
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function SequenceDrawer({ sequence: s, onClose, notify, onChanged }: { sequence: SeqListRow; onClose: () => void; notify: (tone: Notice["tone"], text: string) => void; onChanged: () => void }) {
  const [enrollments, setEnrollments] = useState<EnrollmentWithContact[] | null>(null);
  const [ids, setIds] = useState("");
  const [busy, setBusy] = useState(false);
  const steps = parseSteps(s.steps);
  const cfg = parseTriggerConfig(s.trigger_config);

  const load = useCallback(async () => {
    try {
      setEnrollments((await jsonFetch<{ enrollments: EnrollmentWithContact[] }>(`/api/marketing/sequences/${s.id}/enrollments`)).enrollments);
    } catch (e) {
      notify("error", e instanceof Error ? e.message : "Could not load enrollments");
      setEnrollments([]);
    }
  }, [s.id, notify]);
  useEffect(() => {
    void load();
  }, [load]);

  async function enrollNow() {
    const list = ids.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
    if (list.length === 0) return;
    setBusy(true);
    try {
      const d = await jsonFetch<{ created: number; existing: number; errors: Array<{ contact_id: string; reason: string }> }>(`/api/marketing/sequences/${s.id}/enroll`, { method: "POST", body: JSON.stringify({ contact_ids: list }) }, "Could not enroll");
      notify(d.errors.length ? "info" : "success", `${d.created} enrolled, ${d.existing} already present${d.errors.length ? `, ${d.errors.length} not found` : ""}.`);
      setIds("");
      await load();
      onChanged();
    } catch (e) {
      notify("error", e instanceof Error ? e.message : "Could not enroll");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      labelledBy="sequence-drawer-title"
      onClose={onClose}
      header={
        <div className="min-w-0">
          <h2 id="sequence-drawer-title" className="truncate text-base font-semibold">
            {s.name}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {TRIGGER_LABEL[s.trigger]}
            {cfg.audience_id ? ` · audience ${cfg.audience_id.slice(0, 8)}…` : ""}
          </p>
        </div>
      }
    >
      <div className="space-y-5">
        <section aria-labelledby="steps-h">
          <h3 id="steps-h" className="mb-2 text-sm font-medium">
            Steps
          </h3>
          <ol className="space-y-1.5 text-sm">
            {steps.map((st, i) => (
              <li key={i} className="flex items-start gap-2 rounded-md border border-border px-3 py-2">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-secondary text-[11px] font-medium">{i + 1}</span>
                <span className="min-w-0">
                  <span className="block text-xs text-muted-foreground">
                    {st.delay_hours === 0 ? "Immediately" : `After ${st.delay_hours}h`} · {st.channel === "sms" ? "SMS" : "Email"}
                  </span>
                  <span className="block truncate">{st.template_id ? "Template" : st.subject || st.body_md?.slice(0, 80) || "—"}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>
        <section aria-labelledby="enroll-h">
          <h3 id="enroll-h" className="mb-2 text-sm font-medium">
            Enroll contacts
          </h3>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input value={ids} onChange={(e) => setIds(e.target.value)} placeholder="Contact IDs, comma or space separated" aria-label="Contact IDs to enroll" autoComplete="off" spellCheck={false} />
            <Button type="button" touch disabled={busy || !ids.trim() || s.status !== "active"} onClick={enrollNow}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <UserPlus className="h-4 w-4" aria-hidden />} Enroll
            </Button>
          </div>
          {s.status !== "active" && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Resume the sequence to enroll contacts.</p>}
        </section>
        <section aria-labelledby="enrollments-h">
          <h3 id="enrollments-h" className="mb-2 text-sm font-medium">
            Enrollments
          </h3>
          {enrollments === null ? (
            <SkeletonList count={3} itemClassName="h-8" label="Loading enrollments…" />
          ) : enrollments.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nobody is enrolled yet.</p>
          ) : (
            <TableScroller label="Enrollments">
              <table className="w-full text-xs">
                <thead className={THEAD}>
                  <tr>
                    <th scope="col" className={TH}>
                      Contact
                    </th>
                    <th scope="col" className={TH}>
                      Step
                    </th>
                    <th scope="col" className={TH}>
                      Status
                    </th>
                    <th scope="col" className={TH}>
                      Next send
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {enrollments.map((e) => (
                    <tr key={e.id} className="border-t border-border">
                      <td className="px-3 py-2">
                        <p className="font-medium">{e.full_name ?? e.contact_id}</p>
                        <p className="text-muted-foreground">{e.email ?? ""}</p>
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        {Math.min(e.step_index + 1, steps.length)}/{steps.length}
                      </td>
                      <td className="px-3 py-2">
                        <StatusPill status={e.status} map={ENROLLMENT_TONE} />
                        {e.exited_reason && <p className="mt-0.5 text-muted-foreground">{e.exited_reason.replace(/_/g, " ")}</p>}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{e.status === "active" && e.next_at ? timeAgo(e.next_at) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroller>
          )}
        </section>
      </div>
    </Drawer>
  );
}
