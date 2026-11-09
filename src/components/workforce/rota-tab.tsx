"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, CalendarPlus, ChevronLeft, ChevronRight, Copy, Loader2, Plus, Send, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Banner, Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { isAbortError, useAbortable } from "@/components/ui/hooks";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Pill, StatusPill } from "@/components/ui/pill";
import { cn } from "@/lib/utils";
import { addDays, weekStartOf, type ShiftConflict, type ShiftDTO, type StaffDTO, type SwapDTO } from "@/lib/workforce/pure";
import type { WeekView } from "@/lib/workforce/shifts";
import type { Notice } from "@/app/(app)/workforce/page";
import { fmtDay, fmtTime, fromLocalInput, hours, jsonFetch, readError, SHIFT_TONE, todayYmd, toLocalInput } from "./shared";

type Week = WeekView & { swaps: SwapDTO[] };

const OPEN = "__open__";

export function RotaTab({ staff, notify }: { staff: StaffDTO[]; notify: (tone: Notice["tone"], text: string) => void }) {
  const [weekStart, setWeekStart] = useState(() => weekStartOf(todayYmd()));
  const [week, setWeek] = useState<Week | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ shift: ShiftDTO | null; day?: string; staffId?: string | null } | null>(null);
  const [swapFor, setSwapFor] = useState<ShiftDTO | null>(null);
  const nextSignal = useAbortable();

  const load = useCallback(async () => {
    const signal = nextSignal();
    setLoading(true);
    setError(null);
    try {
      const d = await jsonFetch<Week>(`/api/workforce/shifts?week=${weekStart}`, { signal, fallback: "Could not load the rota" });
      setWeek(d);
    } catch (err) {
      if (isAbortError(err)) return;
      setError(err instanceof Error ? err.message : "Could not load the rota");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [weekStart, nextSignal]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(key: string, fn: () => Promise<string>) {
    setBusy(key);
    try {
      const msg = await fn();
      notify("success", msg);
      await load();
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "That didn't work");
    } finally {
      setBusy(null);
    }
  }

  const drafts = week?.shifts.filter((s) => s.status === "draft") ?? [];
  const rows = useMemo(() => {
    const list: Array<{ id: string; name: string; role: string | null; minutes: number; weekly: number }> = staff.map((s) => ({ id: s.id, name: s.display_name, role: s.role_title, minutes: week?.minutesByStaff[s.id] ?? 0, weekly: s.weekly_hours }));
    const hasOpen = (week?.shifts ?? []).some((s) => !s.staff_id);
    if (hasOpen || list.length === 0) list.push({ id: OPEN, name: "Open shifts", role: "Unassigned", minutes: 0, weekly: 0 });
    return list;
  }, [staff, week]);

  const tz = week?.timezone ?? "UTC";
  const today = todayYmd();

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" touch aria-label="Previous week" onClick={() => setWeekStart((w) => addDays(w, -7))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" touch onClick={() => setWeekStart(weekStartOf(today))}>
            This week
          </Button>
          <Button variant="outline" size="icon" touch aria-label="Next week" onClick={() => setWeekStart((w) => addDays(w, 7))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <p className="ml-2 text-sm font-medium" aria-live="polite">
            {fmtDay(weekStart, { month: "short", day: "numeric" })} – {fmtDay(addDays(weekStart, 6), { month: "short", day: "numeric", year: "numeric" })}
            <span className="ml-2 text-xs font-normal text-muted-foreground">{tz}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {week && week.pendingSwaps > 0 && (
            <Pill tone="warning" title="Pending swap requests">
              <ArrowLeftRight className="h-3 w-3" aria-hidden /> {week.pendingSwaps} swap{week.pendingSwaps === 1 ? "" : "s"}
            </Pill>
          )}
          <Button variant="outline" size="sm" touch disabled={busy !== null} onClick={() => void act("copy", async () => {
            const r = await jsonFetch<{ created: number; skipped: number }>("/api/workforce/shifts/copy-week", { method: "POST", body: JSON.stringify({ source_week: addDays(weekStart, -7), target_week: weekStart }), fallback: "Could not copy" });
            return `Copied ${r.created} shift${r.created === 1 ? "" : "s"} from last week${r.skipped ? ` (${r.skipped} skipped for conflicts)` : ""}.`;
          })}>
            {busy === "copy" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" />} Copy last week
          </Button>
          <Button size="sm" touch disabled={drafts.length === 0 || busy !== null} onClick={() => void act("publish", async () => {
            const r = await jsonFetch<{ published: ShiftDTO[] }>("/api/workforce/shifts/publish", { method: "POST", body: JSON.stringify({ ids: drafts.map((d) => d.id) }), fallback: "Could not publish" });
            return `Published ${r.published.length} shift${r.published.length === 1 ? "" : "s"}. Staff with an email have been notified.`;
          })}>
            {busy === "publish" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Publish week{drafts.length ? ` (${drafts.length})` : ""}
          </Button>
          <Button size="sm" touch variant="secondary" onClick={() => setEditing({ shift: null, day: weekStart })}>
            <Plus className="h-4 w-4" /> New shift
          </Button>
        </div>
      </div>

      {week && week.swaps.length > 0 && (
        <section aria-labelledby="swaps-heading" className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
          <h3 id="swaps-heading" className="text-sm font-semibold">
            Swap requests
          </h3>
          <ul className="mt-2 space-y-2">
            {week.swaps.map((w) => (
              <li key={w.id} className="flex flex-col gap-2 text-sm sm:flex-row sm:items-center sm:justify-between">
                <span>
                  <strong>{w.from_staff_name ?? "Someone"}</strong> → <strong>{w.to_staff_name ?? "someone"}</strong>
                  {w.shift_starts_at && `, ${fmtDay(w.shift_starts_at.slice(0, 10))} ${fmtTime(w.shift_starts_at, tz)}`}
                  {w.note && <span className="text-muted-foreground"> — {w.note}</span>}
                </span>
                <span className="flex gap-2">
                  <Button size="sm" touch disabled={busy !== null} onClick={() => void act(w.id, async () => { await jsonFetch(`/api/workforce/shifts/swaps/${w.id}`, { method: "PATCH", body: JSON.stringify({ decision: "approve" }), fallback: "Could not approve" }); return "Swap approved."; })}>
                    Approve
                  </Button>
                  <Button size="sm" touch variant="outline" disabled={busy !== null} onClick={() => void act(w.id, async () => { await jsonFetch(`/api/workforce/shifts/swaps/${w.id}`, { method: "PATCH", body: JSON.stringify({ decision: "reject" }), fallback: "Could not reject" }); return "Swap rejected."; })}>
                    Reject
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : loading && !week ? (
        <Loading label="Loading rota…" />
      ) : !week ? null : staff.length === 0 && week.shifts.length === 0 ? (
        <Empty icon={<CalendarPlus className="h-6 w-6" aria-hidden />} title="No staff yet" text="Add people under the Staff tab, then build the rota here." />
      ) : (
        <>
          {/* Desktop grid */}
          <div className="hidden overflow-x-auto rounded-lg border border-border md:block" role="region" aria-label="Weekly rota">
            <table className="w-full min-w-[880px] table-fixed border-collapse text-sm">
              <thead className="bg-secondary/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="w-44 px-3 py-2 text-left font-medium">
                    Staff
                  </th>
                  {week.days.map((d) => (
                    <th key={d} scope="col" className={cn("px-2 py-2 text-left font-medium", d === today && "text-primary")}>
                      {fmtDay(d)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-border align-top">
                    <th scope="row" className="px-3 py-2 text-left font-medium">
                      <div className="truncate">{r.name}</div>
                      <div className="text-xs font-normal text-muted-foreground">
                        {r.role ?? "—"}
                        {r.id !== OPEN && (
                          <span className={cn("ml-1", r.weekly > 0 && r.minutes > r.weekly * 60 && "text-amber-600 dark:text-amber-400")}>
                            · {hours(r.minutes)}
                            {r.weekly > 0 ? ` / ${r.weekly}h` : ""}
                          </span>
                        )}
                      </div>
                    </th>
                    {week.days.map((d) => {
                      const cell = (week.byDay[d] ?? []).filter((s) => (r.id === OPEN ? !s.staff_id : s.staff_id === r.id));
                      const onLeave = r.id !== OPEN && (week.leaveDays[r.id] ?? []).includes(d);
                      return (
                        <td key={d} className={cn("px-1.5 py-1.5", onLeave && "bg-secondary/40")}>
                          <div className="flex min-h-14 flex-col gap-1">
                            {onLeave && <span className="text-[11px] text-muted-foreground">On leave</span>}
                            {cell.map((s) => (
                              <ShiftChip key={s.id} shift={s} tz={tz} onClick={() => setEditing({ shift: s })} />
                            ))}
                            <button
                              type="button"
                              onClick={() => setEditing({ shift: null, day: d, staffId: r.id === OPEN ? null : r.id })}
                              className="mt-auto rounded-md border border-dashed border-transparent px-1 py-0.5 text-left text-[11px] text-muted-foreground opacity-0 transition-opacity hover:border-border hover:bg-secondary/60 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 [tr:hover_&]:opacity-100"
                              aria-label={`Add shift for ${r.name} on ${fmtDay(d)}`}
                            >
                              + Add
                            </button>
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile: day-by-day list */}
          <div className="space-y-3 md:hidden">
            {week.days.map((d) => {
              const list = week.byDay[d] ?? [];
              return (
                <section key={d} aria-labelledby={`day-${d}`} className="rounded-lg border border-border">
                  <header className="flex items-center justify-between border-b border-border px-3 py-2">
                    <h3 id={`day-${d}`} className={cn("text-sm font-semibold", d === today && "text-primary")}>
                      {fmtDay(d, { weekday: "long", month: "short", day: "numeric" })}
                    </h3>
                    <Button size="sm" variant="ghost" touch aria-label={`Add shift on ${fmtDay(d)}`} onClick={() => setEditing({ shift: null, day: d })}>
                      <Plus className="h-4 w-4" />
                    </Button>
                  </header>
                  {list.length === 0 ? (
                    <p className="px-3 py-3 text-sm text-muted-foreground">Nobody scheduled.</p>
                  ) : (
                    <ul className="divide-y divide-border">
                      {list.map((s) => (
                        <li key={s.id}>
                          <button type="button" onClick={() => setEditing({ shift: s })} className="flex min-h-14 w-full items-center justify-between gap-3 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-medium">{s.staff_name ?? "Open shift"}</span>
                              <span className="block text-xs text-muted-foreground">
                                {fmtTime(s.starts_at, tz)} – {fmtTime(s.ends_at, tz)} · {hours(s.minutes)}
                                {s.role_title ? ` · ${s.role_title}` : ""}
                              </span>
                            </span>
                            <StatusPill status={s.status} map={SHIFT_TONE} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        </>
      )}

      {editing && (
        <ShiftDialog
          shift={editing.shift}
          day={editing.day}
          staffId={editing.staffId}
          staff={staff}
          tz={tz}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null);
            notify("success", msg);
            void load();
          }}
          onSwap={(s) => {
            setEditing(null);
            setSwapFor(s);
          }}
        />
      )}
      {swapFor && (
        <SwapDialog
          shift={swapFor}
          staff={staff}
          tz={tz}
          onClose={() => setSwapFor(null)}
          onSaved={(msg) => {
            setSwapFor(null);
            notify("success", msg);
            void load();
          }}
        />
      )}
    </div>
  );
}

function ShiftChip({ shift, tz, onClick }: { shift: ShiftDTO; tz: string; onClick: () => void }) {
  const tone = SHIFT_TONE[shift.status];
  const cls: Record<string, string> = {
    neutral: "border-dashed border-border bg-background",
    info: "border-sky-500/40 bg-sky-500/10",
    success: "border-emerald-500/40 bg-emerald-500/10",
    violet: "border-violet-500/40 bg-violet-500/10",
    danger: "border-red-500/40 bg-red-500/10 line-through opacity-70",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("w-full rounded-md border px-1.5 py-1 text-left text-[11px] leading-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", cls[tone] ?? cls.neutral)}
      aria-label={`${shift.staff_name ?? "Open"} shift ${fmtTime(shift.starts_at, tz)} to ${fmtTime(shift.ends_at, tz)}, ${shift.status}`}
    >
      <span className="block font-medium">
        {fmtTime(shift.starts_at, tz)}–{fmtTime(shift.ends_at, tz)}
      </span>
      <span className="block truncate text-muted-foreground">{shift.role_title ?? (shift.status === "draft" ? "Draft" : hours(shift.minutes))}</span>
    </button>
  );
}

function ShiftDialog({
  shift,
  day,
  staffId,
  staff,
  tz,
  onClose,
  onSaved,
  onSwap,
}: {
  shift: ShiftDTO | null;
  day?: string;
  staffId?: string | null;
  staff: StaffDTO[];
  tz: string;
  onClose: () => void;
  onSaved: (msg: string) => void;
  onSwap: (s: ShiftDTO) => void;
}) {
  const base = day ?? todayYmd();
  const [form, setForm] = useState({
    staff_id: shift?.staff_id ?? staffId ?? "",
    role_title: shift?.role_title ?? staff.find((s) => s.id === (shift?.staff_id ?? staffId))?.role_title ?? "",
    start: shift ? toLocalInput(shift.starts_at, tz) : `${base}T09:00`,
    end: shift ? toLocalInput(shift.ends_at, tz) : `${base}T17:00`,
    break_minutes: shift?.break_minutes ?? 30,
    location: shift?.location ?? "",
    notes: shift?.notes ?? "",
    publish: shift ? shift.status !== "draft" : false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<ShiftConflict[] | null>(null);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setConflicts(null);
    try {
      const body = {
        staff_id: form.staff_id || null,
        role_title: form.role_title.trim() || null,
        starts_at: fromLocalInput(form.start, tz),
        ends_at: fromLocalInput(form.end, tz),
        break_minutes: Number(form.break_minutes) || 0,
        location: form.location.trim() || null,
        notes: form.notes.trim() || null,
      };
      const res = await fetch(shift ? `/api/workforce/shifts/${shift.id}` : "/api/workforce/shifts", {
        method: shift ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(shift ? body : { ...body, publish: form.publish }),
      });
      if (res.status === 409) {
        const d = (await res.json().catch(() => ({}))) as { conflicts?: ShiftConflict[]; detail?: string };
        setConflicts(d.conflicts ?? []);
        setError(d.detail ?? "This shift conflicts with the schedule.");
        return;
      }
      if (!res.ok) throw new Error(await readError(res, "Could not save shift"));
      onSaved(shift ? "Shift updated." : form.publish ? "Shift published." : "Draft shift added.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save shift");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!shift) return;
    setSaving(true);
    try {
      const r = await jsonFetch<{ deleted: boolean; cancelled: boolean }>(`/api/workforce/shifts/${shift.id}`, { method: "DELETE", fallback: "Could not remove shift" });
      onSaved(r.deleted ? "Draft removed." : "Shift cancelled.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove shift");
      setSaving(false);
    }
  }

  return (
    <Dialog title={shift ? "Edit shift" : "New shift"} description={shift ? `${shift.status[0].toUpperCase()}${shift.status.slice(1)} · ${hours(shift.minutes)}` : `Times in ${tz}`} onClose={onClose} size="md">
      <form onSubmit={(e) => void save(e)} className="space-y-3">
        {error && (
          <Banner tone={conflicts ? "warn" : "error"}>
            <span className="block">{conflicts ? "Conflict" : error}</span>
            {conflicts && conflicts.length > 0 && (
              <ul className="mt-1 list-disc pl-4 text-xs">
                {conflicts.map((c, i) => (
                  <li key={i}>{c.message}</li>
                ))}
              </ul>
            )}
          </Banner>
        )}
        <Field label="Who" hint="Leave empty for an open shift">
          <Select value={form.staff_id} onChange={(e) => set("staff_id", e.target.value)}>
            <option value="">Open shift (unassigned)</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.display_name}
                {s.role_title ? ` · ${s.role_title}` : ""}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Starts" required>
            <Input type="datetime-local" value={form.start} onChange={(e) => set("start", e.target.value)} required />
          </Field>
          <Field label="Ends" required>
            <Input type="datetime-local" value={form.end} onChange={(e) => set("end", e.target.value)} required />
          </Field>
          <Field label="Break (minutes)">
            <Input type="number" inputMode="numeric" min={0} max={600} value={form.break_minutes} onChange={(e) => set("break_minutes", Number(e.target.value))} />
          </Field>
          <Field label="Role">
            <Input value={form.role_title} onChange={(e) => set("role_title", e.target.value)} placeholder="e.g. Technician" maxLength={80} />
          </Field>
          <Field label="Location" className="sm:col-span-2">
            <Input value={form.location} onChange={(e) => set("location", e.target.value)} placeholder="Site, store or 'Remote'" maxLength={120} />
          </Field>
          <Field label="Notes" className="sm:col-span-2">
            <Textarea rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} maxLength={2000} />
          </Field>
        </div>
        {!shift && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4" checked={form.publish} onChange={(e) => set("publish", e.target.checked)} /> Publish immediately (notifies the person)
          </label>
        )}
        <DialogFooter
          start={
            shift && (
              <span className="flex flex-wrap gap-2">
                <Button type="button" variant="ghost" size="sm" touch disabled={saving} onClick={() => void remove()}>
                  <Trash2 className="h-4 w-4" /> {shift.status === "draft" ? "Delete" : "Cancel shift"}
                </Button>
                {shift.staff_id && shift.status !== "cancelled" && (
                  <Button type="button" variant="ghost" size="sm" touch disabled={saving} onClick={() => onSwap(shift)}>
                    <ArrowLeftRight className="h-4 w-4" /> Swap
                  </Button>
                )}
              </span>
            )
          }
        >
          <Button type="button" variant="outline" touch onClick={onClose}>
            Close
          </Button>
          <Button type="submit" touch disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} {shift ? "Save" : form.publish ? "Publish shift" : "Add draft"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function SwapDialog({ shift, staff, tz, onClose, onSaved }: { shift: ShiftDTO; staff: StaffDTO[]; tz: string; onClose: () => void; onSaved: (msg: string) => void }) {
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await jsonFetch(`/api/workforce/shifts/${shift.id}/swap`, { method: "POST", body: JSON.stringify({ to_staff_id: to, note: note.trim() || null }), fallback: "Could not request swap" });
      onSaved("Swap requested. Approve it from the rota when ready.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not request swap");
      setSaving(false);
    }
  }
  return (
    <Dialog title="Request a swap" description={`${shift.staff_name ?? "This shift"} · ${fmtDay(shift.starts_at.slice(0, 10))} ${fmtTime(shift.starts_at, tz)}–${fmtTime(shift.ends_at, tz)}`} onClose={onClose} size="sm">
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {error && <Banner tone="error">{error}</Banner>}
        <Field label="Hand over to" required>
          <Select value={to} onChange={(e) => setTo(e.target.value)} required>
            <option value="">Choose a colleague…</option>
            {staff.filter((s) => s.id !== shift.staff_id).map((s) => (
              <option key={s.id} value={s.id}>
                {s.display_name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Note">
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" touch onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" touch disabled={saving || !to}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Request swap
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
