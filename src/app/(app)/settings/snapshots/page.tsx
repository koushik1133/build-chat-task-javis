"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DatabaseBackup, Download, Loader2, Play, Plus, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Banner, Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/input";
import { Pill, type Tone } from "@/components/ui/pill";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { PageContainer } from "@/components/page-container";
import { ExportEverythingCard } from "@/components/snapshots/export-everything-card";
import { NEVER_INCLUDED, SECTION_KEYS, SECTION_LABELS } from "@/lib/snapshots/types";
import type { ApplicationDTO, ApplyMode, ApplyResult, SectionKey, SnapshotMeta, SnapshotPlan } from "@/lib/snapshots/types";

type Notice = { tone: "success" | "error" | "warn"; text: string };
const ACTION_TONE: Record<string, Tone> = { create: "success", update: "info", skip: "neutral" };
const STATUS_TONE: Record<string, Tone> = { applied: "success", partial: "warning", failed: "danger" };
const fmt = (iso: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const spinner = <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />;

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const d = (await res.json().catch(() => null)) as (T & { error?: string; detail?: string }) | null;
  if (!res.ok) throw new Error(d?.detail ?? d?.error ?? `Request failed (${res.status})`);
  return d as T;
}

function SectionPicker({ value, onChange, available, counts }: { value: Set<SectionKey>; onChange: (v: Set<SectionKey>) => void; available: readonly SectionKey[]; counts?: Record<string, number> | null }) {
  return (
    <fieldset className="grid gap-1.5 sm:grid-cols-2">
      <legend className="mb-1 text-xs font-medium">Sections</legend>
      {available.map((k) => (
        <Checkbox
          key={k}
          checked={value.has(k)}
          onChange={(e) => {
            const next = new Set(value);
            if (e.target.checked) next.add(k);
            else next.delete(k);
            onChange(next);
          }}
          label={
            <span className="text-sm">
              {SECTION_LABELS[k]}
              {counts && <span className="ml-1 text-xs text-muted-foreground">({counts[k] ?? 0})</span>}
            </span>
          }
        />
      ))}
    </fieldset>
  );
}

function CreateDialog({ counts, onClose, onDone }: { counts: Record<string, number> | null; onClose: () => void; onDone: (msg: Notice) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [shared, setShared] = useState(false);
  const [sections, setSections] = useState<Set<SectionKey>>(new Set(SECTION_KEYS));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ warnings: string[] }>("/api/snapshots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description: description || null, sections: [...sections], visibility: shared ? "agency" : "private" }),
      });
      onDone({ tone: r.warnings.length ? "warn" : "success", text: r.warnings.length ? `Snapshot saved with warnings: ${r.warnings.join("; ")}` : "Snapshot saved." });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the snapshot");
      setBusy(false);
    }
  }

  return (
    <Dialog title="New snapshot" description="Capture this workspace's configuration as a portable template." onClose={onClose} size="lg">
      <form onSubmit={submit} className="space-y-4">
        {error && <Banner tone="error">{error}</Banner>}
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required autoFocus />
        </Field>
        <Field label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} rows={2} />
        </Field>
        <SectionPicker value={sections} onChange={setSections} available={SECTION_KEYS} counts={counts} />
        <Checkbox checked={shared} onChange={(e) => setShared(e.target.checked)} label={<span className="text-sm">Share with client workspaces (agency): new clients can start from this snapshot</span>} />
        <p className="text-xs text-muted-foreground">Never included: {NEVER_INCLUDED.join(", ")}.</p>
        <DialogFooter>
          <Button type="button" variant="outline" touch onClick={onClose}>Cancel</Button>
          <Button type="submit" touch disabled={busy || !name.trim() || sections.size === 0}>{busy ? spinner : <DatabaseBackup className="h-4 w-4" aria-hidden />} Create snapshot</Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function PlanTable({ plan }: { plan: SnapshotPlan }) {
  if (plan.sections.length === 0) return <Empty title="Nothing to apply" text="The selected sections are not in this snapshot." />;
  return (
    <div className="space-y-3">
      <p className="text-sm">
        <strong>{plan.totals.create}</strong> to create, <strong>{plan.totals.update}</strong> to update, <strong>{plan.totals.skip}</strong> unchanged or skipped
        {plan.totals.conflicts > 0 && <>, <strong>{plan.totals.conflicts}</strong> conflict{plan.totals.conflicts === 1 ? "" : "s"}</>}.
      </p>
      <TableScroller label="Snapshot plan by section">
        <table className="w-full text-sm">
          <thead className={THEAD}>
            <tr><th className={TH}>Section</th><th className={TH}>Create</th><th className={TH}>Update</th><th className={TH}>Skip</th><th className={TH}>Conflicts</th></tr>
          </thead>
          <tbody>
            {plan.sections.map((s) => (
              <tr key={s.section} className="border-t border-border align-top">
                <td className="px-3 py-2">{SECTION_LABELS[s.section]}</td>
                <td className="px-3 py-2">{s.create}</td>
                <td className="px-3 py-2">{s.update}</td>
                <td className="px-3 py-2">{s.skip}</td>
                <td className="px-3 py-2">
                  {s.conflicts.length === 0 ? "—" : <span className="text-amber-700 dark:text-amber-300">{s.conflicts.slice(0, 5).join(", ")}{s.conflicts.length > 5 ? ` +${s.conflicts.length - 5}` : ""}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroller>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">Item details</summary>
        <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto">
          {plan.sections.flatMap((s) => s.items.map((i) => (
            <li key={`${s.section}:${i.key}`} className="flex flex-wrap items-center gap-2">
              <Pill tone={ACTION_TONE[i.action]}>{i.action}</Pill>
              <span className="min-w-0 break-words">{s.section} / {i.key}</span>
              {i.reason && <span className="text-xs text-muted-foreground">{i.reason}</span>}
            </li>
          )))}
        </ul>
      </details>
    </div>
  );
}

function ApplyDialog({ snap, onClose, onDone }: { snap: SnapshotMeta; onClose: () => void; onDone: (msg: Notice) => void }) {
  const [mode, setMode] = useState<ApplyMode>("skip_existing");
  const [sections, setSections] = useState<Set<SectionKey>>(new Set(snap.sections));
  const [plan, setPlan] = useState<SnapshotPlan | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const body = JSON.stringify({ target: "self", sections: [...sections], mode });
  const headers = { "Content-Type": "application/json" };

  async function preview() {
    setBusy(true);
    setError(null);
    setConfirming(false);
    try {
      setPlan((await api<{ plan: SnapshotPlan }>(`/api/snapshots/${snap.id}/plan`, { method: "POST", headers, body })).plan);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not build the plan");
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    setBusy(true);
    setError(null);
    try {
      const { result } = await api<{ result: ApplyResult }>(`/api/snapshots/${snap.id}/apply`, { method: "POST", headers, body });
      const errs = result.errors.length;
      onDone({ tone: errs ? "warn" : "success", text: `Applied: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped${errs ? `, ${errs} error${errs === 1 ? "" : "s"} (${result.errors[0].section}: ${result.errors[0].message})` : ""}.` });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Apply failed");
      setBusy(false);
    }
  }

  return (
    <Dialog title={`Apply "${snap.name}"`} description="Review what would change before applying to this workspace." onClose={onClose} size="xl">
      <div className="space-y-4">
        {error && <Banner tone="error">{error}</Banner>}
        <Field label="Mode" hint={mode === "skip_existing" ? "Existing items are never touched." : "Updates only items a previous snapshot created here; your own items are left alone."}>
          <Select value={mode} onChange={(e) => { setMode(e.target.value as ApplyMode); setPlan(null); setConfirming(false); }}>
            <option value="skip_existing">Skip existing (safe)</option>
            <option value="merge">Merge (update snapshot-owned items)</option>
          </Select>
        </Field>
        <SectionPicker value={sections} onChange={(v) => { setSections(v); setPlan(null); setConfirming(false); }} available={snap.sections} />
        {plan && <PlanTable plan={plan} />}
        {confirming && plan && (
          <Banner tone="warn">This will change this workspace: {plan.totals.create} created, {plan.totals.update} updated. Automations arrive paused and agents idle. Continue?</Banner>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" touch onClick={onClose}>Close</Button>
          <Button type="button" variant="outline" touch disabled={busy || sections.size === 0} onClick={preview}>{busy && !confirming ? spinner : null} Preview changes</Button>
          {!confirming ? (
            <Button type="button" touch disabled={busy || !plan || plan.totals.create + plan.totals.update === 0} onClick={() => setConfirming(true)}><Play className="h-4 w-4" aria-hidden /> Apply…</Button>
          ) : (
            <Button type="button" touch disabled={busy} onClick={apply}>{busy ? spinner : <Play className="h-4 w-4" aria-hidden />} Confirm apply</Button>
          )}
        </DialogFooter>
      </div>
    </Dialog>
  );
}

export default function SnapshotsPage() {
  const [snaps, setSnaps] = useState<SnapshotMeta[] | null>(null);
  const [apps, setApps] = useState<ApplicationDTO[]>([]);
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [creating, setCreating] = useState(false);
  const [applying, setApplying] = useState<SnapshotMeta | null>(null);
  const [deleting, setDeleting] = useState<SnapshotMeta | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const d = await api<{ snapshots: SnapshotMeta[]; counts?: Record<string, number>; applications?: ApplicationDTO[]; canEdit: boolean }>("/api/snapshots?counts=1&applications=1");
      setSnaps(d.snapshots);
      setCounts(d.counts ?? null);
      setApps(d.applications ?? []);
      setCanEdit(d.canEdit);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load snapshots");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function onImport(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      await api("/api/snapshots/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: await file.text() });
      setNotice({ tone: "success", text: "Snapshot imported." });
      await load();
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Import failed" });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function remove(s: SnapshotMeta) {
    setBusy(true);
    try {
      await api(`/api/snapshots/${s.id}`, { method: "DELETE" });
      setNotice({ tone: "success", text: `Deleted "${s.name}".` });
      setDeleting(null);
      await load();
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Delete failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageContainer
      wide
      title="Snapshots & backup"
      description="Save this workspace's configuration as a portable template, apply it to another workspace, or export everything for backup."
      icon={<DatabaseBackup className="h-5 w-5" aria-hidden />}
      actions={
        canEdit ? (
          <div className="flex flex-wrap gap-2">
            <input ref={fileRef} type="file" accept="application/json,.json" className="sr-only" aria-label="Import snapshot file" onChange={(e) => void onImport(e.target.files?.[0])} />
            <Button variant="outline" touch disabled={busy} onClick={() => fileRef.current?.click()}><Upload className="h-4 w-4" aria-hidden /> Import</Button>
            <Button touch onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden /> New snapshot</Button>
          </div>
        ) : undefined
      }
    >
      {notice && <Banner tone={notice.tone} onDismiss={() => setNotice(null)} className="mb-4">{notice.text}</Banner>}
      {error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : snaps === null ? (
        <Loading label="Loading snapshots…" />
      ) : (
        <div className="space-y-8">
          <section aria-labelledby="snap-list">
            <h2 id="snap-list" className="mb-2 text-sm font-semibold">Snapshots</h2>
            {snaps.length === 0 ? (
              <Empty title="No snapshots yet" text="Create one from this workspace, or import a snapshot file." />
            ) : (
              <TableScroller label="Snapshots">
                <table className="w-full text-sm">
                  <thead className={THEAD}>
                    <tr><th className={TH}>Name</th><th className={TH}>Sections</th><th className={TH}>Size</th><th className={TH}>Created</th><th className={TH}><span className="sr-only">Actions</span></th></tr>
                  </thead>
                  <tbody>
                    {snaps.map((s) => (
                      <tr key={s.id} className="border-t border-border align-top">
                        <td className="px-3 py-2">
                          <div className="font-medium">{s.name}</div>
                          {s.description && <div className="max-w-xs text-xs text-muted-foreground">{s.description}</div>}
                          <div className="mt-1 flex gap-1">
                            {s.origin === "agency" && <Pill tone="violet">From your agency</Pill>}
                            {s.visibility === "agency" && s.origin !== "agency" && <Pill tone="accent">Shared with clients</Pill>}
                          </div>
                        </td>
                        <td className="px-3 py-2"><Pill tone="neutral" title={s.sections.map((k) => SECTION_LABELS[k]).join(", ")}>{s.sections.length} sections</Pill></td>
                        <td className="whitespace-nowrap px-3 py-2">{kb(s.size_bytes)}</td>
                        <td className="whitespace-nowrap px-3 py-2">{fmt(s.created_at)}</td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap justify-end gap-2">
                            {canEdit && <Button size="sm" variant="outline" touch onClick={() => setApplying(s)}><Play className="h-3.5 w-3.5" aria-hidden /> Apply</Button>}
                            <Button size="sm" variant="outline" touch asChild><a href={`/api/snapshots/${s.id}?download=1`} aria-label={`Download ${s.name}`}><Download className="h-3.5 w-3.5" aria-hidden /> Download</a></Button>
                            {canEdit && s.origin !== "agency" && <Button size="sm" variant="outline" touch onClick={() => setDeleting(s)} aria-label={`Delete ${s.name}`}><Trash2 className="h-3.5 w-3.5" aria-hidden /></Button>}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroller>
            )}
          </section>

          <section aria-labelledby="snap-history">
            <h2 id="snap-history" className="mb-2 text-sm font-semibold">Application history</h2>
            {apps.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing has been applied to this workspace yet.</p>
            ) : (
              <TableScroller label="Snapshot applications">
                <table className="w-full text-sm">
                  <thead className={THEAD}>
                    <tr><th className={TH}>When</th><th className={TH}>Snapshot</th><th className={TH}>Mode</th><th className={TH}>Result</th><th className={TH}>Status</th></tr>
                  </thead>
                  <tbody>
                    {apps.map((a) => (
                      <tr key={a.id} className="border-t border-border">
                        <td className="whitespace-nowrap px-3 py-2">{fmt(a.created_at)}</td>
                        <td className="px-3 py-2">{a.snapshot_name ?? "(deleted)"}</td>
                        <td className="px-3 py-2">{a.mode === "merge" ? "Merge" : "Skip existing"}</td>
                        <td className="px-3 py-2">{a.created} created, {a.updated} updated, {a.skipped} skipped{a.errors ? `, ${a.errors} errors` : ""}</td>
                        <td className="px-3 py-2"><Pill tone={STATUS_TONE[a.status] ?? "neutral"}>{a.status}</Pill></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroller>
            )}
          </section>

          <ExportEverythingCard />
        </div>
      )}

      {creating && <CreateDialog counts={counts} onClose={() => setCreating(false)} onDone={(n) => { setCreating(false); setNotice(n); void load(); }} />}
      {applying && <ApplyDialog snap={applying} onClose={() => setApplying(null)} onDone={(n) => { setApplying(null); setNotice(n); void load(); }} />}
      {deleting && (
        <Dialog title="Delete snapshot?" description={`"${deleting.name}" will be removed. Configuration already applied from it is not affected.`} onClose={() => setDeleting(null)} size="sm">
          <DialogFooter>
            <Button variant="outline" touch onClick={() => setDeleting(null)}>Cancel</Button>
            <Button touch disabled={busy} onClick={() => void remove(deleting)}>{busy ? spinner : <Trash2 className="h-4 w-4" aria-hidden />} Delete</Button>
          </DialogFooter>
        </Dialog>
      )}
    </PageContainer>
  );
}
