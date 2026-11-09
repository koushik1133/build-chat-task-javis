"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarClock, Download, FileText, Pencil, Play, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select, Checkbox } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Banner, Empty, SkeletonList } from "@/components/ui/feedback";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Pill } from "@/components/ui/pill";
import { api } from "@/components/finance/shared";
import { ReportChart } from "./report-chart";
import { ReportTable } from "./report-table";
import type { RunResult, SavedReportDTO, ScheduleDTO } from "./types";

/** Saved reports: run inline, export CSV/PDF, schedule, edit in the builder, delete. */

interface Props {
  reports: SavedReportDTO[];
  canEdit: boolean;
  onEdit: (r: SavedReportDTO) => void;
  onChanged: () => void;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function SavedReports({ reports, canEdit, onEdit, onChanged }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, RunResult>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scheduleFor, setScheduleFor] = useState<SavedReportDTO | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<SavedReportDTO | null>(null);

  async function run(r: SavedReportDTO) {
    setBusy(`run:${r.id}`);
    setError(null);
    try {
      const out = await api<{ result: RunResult }>(`/api/reports/saved/${r.id}/run`, { method: "POST" });
      setResult((m) => ({ ...m, [r.id]: out.result }));
      setOpen(r.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not run the report.");
    } finally {
      setBusy(null);
    }
  }

  async function exportReport(r: SavedReportDTO, format: "csv" | "pdf") {
    setBusy(`${format}:${r.id}`);
    setError(null);
    try {
      const res = await fetch(`/api/reports/saved/${r.id}/export?format=${format}`);
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.detail ?? data?.error ?? `Export failed (${res.status})`);
      }
      const blob = await res.blob();
      const name = res.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? `${r.name}.${format}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed.");
    } finally {
      setBusy(null);
    }
  }

  async function remove(r: SavedReportDTO) {
    setBusy(`del:${r.id}`);
    try {
      await api(`/api/reports/saved/${r.id}`, { method: "DELETE" });
      setConfirmDelete(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete.");
    } finally {
      setBusy(null);
    }
  }

  if (reports.length === 0) return <Empty icon={<FileText className="h-5 w-5" aria-hidden />} title="No saved reports yet" text="Build a report in the Builder tab and save it to run, export or schedule it here." />;

  return (
    <div className="space-y-3">
      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}
      <ul className="space-y-3">
        {reports.map((r) => {
          const res = result[r.id];
          const isOpen = open === r.id;
          return (
            <li key={r.id} className="rounded-xl border border-border bg-card">
              <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="min-w-0 break-words font-medium">{r.name}</h3>
                    <Pill tone="neutral">{r.spec.dataset.replace(/^records:/, "records · ")}</Pill>
                    <Pill tone="info">{r.chart.type}</Pill>
                    {r.visibility === "private" && <Pill tone="violet">Only me</Pill>}
                  </div>
                  {r.description && <p className="mt-1 text-sm text-muted-foreground">{r.description}</p>}
                  <p className="mt-1 text-xs text-muted-foreground">Updated <time dateTime={r.updated_at}>{new Date(r.updated_at).toLocaleString()}</time></p>
                </div>
                <div className="flex flex-wrap gap-1.5 sm:shrink-0">
                  <Button size="sm" variant="outline" touch onClick={() => (isOpen ? setOpen(null) : void run(r))} disabled={busy === `run:${r.id}`} aria-expanded={isOpen} aria-controls={`saved-${r.id}-result`}>
                    <Play className="h-4 w-4" aria-hidden /> {busy === `run:${r.id}` ? "Running…" : isOpen ? "Hide" : "Run"}
                  </Button>
                  <Button size="sm" variant="outline" touch onClick={() => void exportReport(r, "csv")} disabled={busy === `csv:${r.id}`} aria-label={`Export ${r.name} as CSV`}>
                    <Download className="h-4 w-4" aria-hidden /> CSV
                  </Button>
                  <Button size="sm" variant="outline" touch onClick={() => void exportReport(r, "pdf")} disabled={busy === `pdf:${r.id}`} aria-label={`Export ${r.name} as PDF`}>
                    <FileText className="h-4 w-4" aria-hidden /> PDF
                  </Button>
                  {canEdit && (
                    <>
                      <Button size="sm" variant="outline" touch onClick={() => setScheduleFor(r)} aria-label={`Schedule ${r.name}`}>
                        <CalendarClock className="h-4 w-4" aria-hidden /> Schedule
                      </Button>
                      <Button size="sm" variant="ghost" touch onClick={() => onEdit(r)} aria-label={`Edit ${r.name}`}>
                        <Pencil className="h-4 w-4" aria-hidden />
                      </Button>
                      <Button size="sm" variant="ghost" touch onClick={() => setConfirmDelete(r)} disabled={busy === `del:${r.id}`} aria-label={`Delete ${r.name}`}>
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </Button>
                    </>
                  )}
                </div>
              </div>
              {isOpen && res && (
                <div id={`saved-${r.id}-result`} className="space-y-3 border-t border-border p-4">
                  <p className="text-xs tabular-nums text-muted-foreground" role="status">{res.row_count} row{res.row_count === 1 ? "" : "s"}{res.truncated ? " (limited)" : ""}</p>
                  {r.chart.type !== "table" && <ReportChart rows={res.rows} columns={res.columns} chart={r.chart} currency={res.currency} title={r.name} />}
                  <ReportTable rows={res.rows} columns={res.columns} totals={res.totals} currency={res.currency} label={r.name} max={50} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {scheduleFor && <ScheduleDialog report={scheduleFor} onClose={() => setScheduleFor(null)} />}
      {confirmDelete && (
        <Dialog title={`Delete “${confirmDelete.name}”?`} description="The report, its schedules and any dashboard cards that use it are removed. This cannot be undone." onClose={() => setConfirmDelete(null)} size="sm">
          <DialogFooter>
            <Button type="button" variant="outline" touch onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button type="button" variant="destructive" touch disabled={busy === `del:${confirmDelete.id}`} onClick={() => void remove(confirmDelete)}>
              {busy === `del:${confirmDelete.id}` ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </div>
  );
}

function ScheduleDialog({ report, onClose }: { report: SavedReportDTO; onClose: () => void }) {
  const [list, setList] = useState<ScheduleDTO[] | null>(null);
  const [cadence, setCadence] = useState<ScheduleDTO["cadence"]>("weekly");
  const [hour, setHour] = useState(8);
  const [weekday, setWeekday] = useState(1);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [recipients, setRecipients] = useState("");
  const [format, setFormat] = useState<ScheduleDTO["format"]>("inline");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ schedules: ScheduleDTO[] }>(`/api/reports/schedules?report_id=${encodeURIComponent(report.id)}`);
      setList(r.schedules);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load schedules.");
      setList([]);
    }
  }, [report.id]);
  useEffect(() => {
    void load();
  }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api("/api/reports/schedules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ report_id: report.id, cadence, hour, weekday: cadence === "weekly" ? weekday : null, day_of_month: cadence === "monthly" ? dayOfMonth : null, recipients: recipients.split(/[,\s]+/).filter(Boolean), format }),
      });
      setRecipients("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not schedule.");
    } finally {
      setSaving(false);
    }
  }
  async function toggle(s: ScheduleDTO) {
    setError(null);
    try {
      await api(`/api/reports/schedules/${s.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !s.enabled }) });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update the schedule.");
    }
    await load();
  }
  async function remove(s: ScheduleDTO) {
    setError(null);
    try {
      await api(`/api/reports/schedules/${s.id}`, { method: "DELETE" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete the schedule.");
    }
    await load();
  }

  return (
    <Dialog title={`Schedule “${report.name}”`} description="Email this report on a cadence. Times are in your workspace time zone." onClose={onClose}>
      <div className="space-y-4">
        {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}
        {list === null && <SkeletonList count={2} itemClassName="h-12" label="Loading schedules…" />}
        {list && list.length > 0 && (
          <ul className="divide-y divide-border rounded-lg border border-border text-sm" aria-label="Existing schedules">
            {list.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <div className="min-w-0">
                  <p className="font-medium capitalize">{s.cadence} · {String(s.hour).padStart(2, "0")}:00 · {s.format}</p>
                  <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{s.recipients.join(", ")}{s.next_run_at ? ` · next ${new Date(s.next_run_at).toLocaleString()}` : ""}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox label={s.enabled ? "On" : "Off"} checked={s.enabled} onChange={() => void toggle(s)} />
                  <Button size="icon" variant="ghost" touch onClick={() => void remove(s)} aria-label={`Delete ${s.cadence} schedule`}><Trash2 className="h-4 w-4" aria-hidden /></Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Cadence">
              <Select value={cadence} onChange={(e) => setCadence(e.target.value as ScheduleDTO["cadence"])}>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </Select>
            </Field>
            <Field label="Hour">
              <Select value={hour} onChange={(e) => setHour(Number(e.target.value))}>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>
                ))}
              </Select>
            </Field>
            {cadence === "weekly" && (
              <Field label="Weekday">
                <Select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                  {WEEKDAYS.map((d, i) => (
                    <option key={d} value={i}>{d}</option>
                  ))}
                </Select>
              </Field>
            )}
            {cadence === "monthly" && (
              <Field label="Day of month">
                <Input type="number" min={1} max={28} value={dayOfMonth} onChange={(e) => setDayOfMonth(Math.max(1, Math.min(28, Number(e.target.value))))} />
              </Field>
            )}
            <Field label="Format" hint="Inline puts the table in the email; CSV/PDF add a 7-day download link.">
              <Select value={format} onChange={(e) => setFormat(e.target.value as ScheduleDTO["format"])}>
                <option value="inline">Inline table</option>
                <option value="csv">CSV link</option>
                <option value="pdf">PDF link</option>
              </Select>
            </Field>
          </div>
          <Field label="Recipients" hint="Comma-separated emails." required>
            <Input type="text" inputMode="email" autoComplete="off" value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="finance@example.com, ops@example.com" required />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" touch onClick={onClose}>Close</Button>
            <Button type="submit" touch disabled={saving || !recipients.trim()}>{saving ? "Saving…" : "Add schedule"}</Button>
          </DialogFooter>
        </form>
      </div>
    </Dialog>
  );
}
