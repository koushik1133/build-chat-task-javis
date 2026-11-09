"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Banner } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { PROJECT_STATUSES, PROJECT_STATUS_LABEL, type BillingMode, type ProjectDTO, type ProjectStatus } from "@/lib/projects/pure";
import { jsonFetch, type MemberOption } from "./shared";

export function EditProjectDialog({ project, members, onClose, onSaved }: { project: ProjectDTO; members: MemberOption[]; onClose: () => void; onSaved: (p: ProjectDTO) => void }) {
  const [name, setName] = useState(project.name);
  const [code, setCode] = useState(project.code ?? "");
  const [description, setDescription] = useState(project.description_md ?? "");
  const [status, setStatus] = useState<ProjectStatus>(project.status);
  const [startsOn, setStartsOn] = useState(project.starts_on ?? "");
  const [dueOn, setDueOn] = useState(project.due_on ?? "");
  const [budget, setBudget] = useState(String(project.budget_minor / 100));
  const [currency, setCurrency] = useState(project.currency);
  const [billing, setBilling] = useState<BillingMode>(project.billing_mode);
  const [rate, setRate] = useState(String(project.hourly_rate_minor / 100));
  const [owner, setOwner] = useState(project.owner_member_id ?? "");
  const [color, setColor] = useState(project.color ?? "#6366f1");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const d = await jsonFetch<{ project: ProjectDTO }>(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: name.trim(),
          code: code.trim() || null,
          description_md: description.trim() || null,
          status,
          starts_on: startsOn || null,
          due_on: dueOn || null,
          budget_minor: Math.round((Number(budget) || 0) * 100),
          currency: currency.trim().toUpperCase() || "USD",
          billing_mode: billing,
          hourly_rate_minor: Math.round((Number(rate) || 0) * 100),
          owner_member_id: owner || null,
          color: color || null,
        }),
        fallback: "Could not save",
      });
      onSaved(d.project);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Edit project" onClose={onClose} size="lg">
      <form onSubmit={submit} className="space-y-3">
        {err && (
          <Banner tone="error" onDismiss={() => setErr(null)}>
            {err}
          </Banner>
        )}
        <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
          </Field>
          <Field label="Code">
            <Input value={code} onChange={(e) => setCode(e.target.value)} maxLength={40} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus)}>
              {PROJECT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {PROJECT_STATUS_LABEL[s]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Owner">
            <Select value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
              {owner && !members.some((m) => m.id === owner) && <option value={owner}>{owner.slice(0, 8)}…</option>}
            </Select>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Starts">
            <Input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
          </Field>
          <Field label="Due">
            <Input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Budget">
            <Input type="number" min={0} step="0.01" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
          </Field>
          <Field label="Currency">
            <Input value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={3} />
          </Field>
          <Field label="Billing">
            <Select value={billing} onChange={(e) => setBilling(e.target.value as BillingMode)}>
              <option value="none">Not billed</option>
              <option value="fixed">Fixed price</option>
              <option value="hourly">Hourly</option>
            </Select>
          </Field>
        </div>
        <Field label="Hourly rate" hint="Used for time entries logged without a rate.">
          <Input type="number" min={0} step="0.01" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
        </Field>
        <Field label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} maxLength={20_000} />
        </Field>
        <Field label="Colour">
          <Input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-10 w-20 p-1" />
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" touch onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" touch disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
