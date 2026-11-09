"use client";

import { useCallback, useEffect, useState } from "react";
import { Clock, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Banner, Empty, ErrorState, SkeletonList } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { isAbortError, useAbortable } from "@/components/ui/hooks";
import { Input, Select } from "@/components/ui/input";
import { Pill } from "@/components/ui/pill";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import type { AttendanceDTO, StaffDTO } from "@/lib/workforce/pure";
import type { Notice } from "@/app/(app)/workforce/page";
import { addDays, weekStartOf } from "@/lib/workforce/pure";
import { fmtDateTime, fmtTime, fromLocalInput, hours, jsonFetch, todayYmd } from "./shared";

function variancePill(v: number | null) {
  if (v === null) return <Pill tone="neutral">Unscheduled</Pill>;
  if (Math.abs(v) <= 10) return <Pill tone="success">On time</Pill>;
  if (v > 0) return <Pill tone="info">+{hours(v)}</Pill>;
  return <Pill tone="warning">−{hours(-v)}</Pill>;
}

export function AttendanceTab({ staff, notify }: { staff: StaffDTO[]; notify: (tone: Notice["tone"], text: string) => void }) {
  const [from, setFrom] = useState(() => weekStartOf(todayYmd()));
  const [to, setTo] = useState(() => addDays(weekStartOf(todayYmd()), 6));
  const [rows, setRows] = useState<AttendanceDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const nextSignal = useAbortable();

  const load = useCallback(async () => {
    const signal = nextSignal();
    setError(null);
    try {
      const d = await jsonFetch<{ attendance: AttendanceDTO[] }>(`/api/workforce/attendance?from=${encodeURIComponent(`${from}T00:00:00Z`)}&to=${encodeURIComponent(`${addDays(to, 1)}T00:00:00Z`)}`, { signal, fallback: "Could not load attendance" });
      setRows(d.attendance);
    } catch (err) {
      if (isAbortError(err)) return;
      setError(err instanceof Error ? err.message : "Could not load attendance");
    }
  }, [from, to, nextSignal]);

  useEffect(() => {
    void load();
  }, [load]);

  const total = (rows ?? []).reduce((s, r) => s + (r.minutes ?? 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="From">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        <div className="flex items-center gap-3">
          {rows && <p className="text-sm tabular-nums text-muted-foreground" role="status" aria-live="polite">{rows.length} record{rows.length === 1 ? "" : "s"} · {hours(total)}</p>}
          <Button size="sm" touch onClick={() => setShowNew(true)} disabled={staff.length === 0}>
            <Plus className="h-4 w-4" aria-hidden /> Manual entry
          </Button>
        </div>
      </div>
      {error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : rows === null ? (
        <SkeletonList count={5} itemClassName="h-12" label="Loading attendance…" />
      ) : rows.length === 0 ? (
        <Empty icon={<Clock className="h-6 w-6" aria-hidden />} title="No clock-ins in this range" text="Give staff a crew link (Staff tab) and their clock in/out lands here, matched to the shift they were scheduled for." />
      ) : (
        <TableScroller label="Attendance">
          <table className="w-full min-w-[44rem] text-sm">
            <thead className={THEAD}>
              <tr>
                <th scope="col" className={TH}>Who</th>
                <th scope="col" className={TH}>Clock in</th>
                <th scope="col" className={TH}>Clock out</th>
                <th scope="col" className={`${TH} text-right`}>Worked</th>
                <th scope="col" className={`${TH} text-right`}>Scheduled</th>
                <th scope="col" className={TH}>Variance</th>
                <th scope="col" className={TH}>Source</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-3 py-2 font-medium">{r.staff_name ?? r.staff_id}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{fmtDateTime(r.clock_in, tz)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{r.clock_out ? fmtTime(r.clock_out, tz) : <Pill tone="info">Open</Pill>}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.minutes === null ? "—" : hours(r.minutes)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.scheduled_minutes === null ? "—" : hours(r.scheduled_minutes)}</td>
                  <td className="px-3 py-2">{r.clock_out ? variancePill(r.variance_minutes) : null}</td>
                  <td className="px-3 py-2 capitalize text-muted-foreground">{r.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      )}
      {showNew && (
        <ManualDialog
          staff={staff}
          tz={tz}
          onClose={() => setShowNew(false)}
          onSaved={(msg) => {
            setShowNew(false);
            notify("success", msg);
            void load();
          }}
        />
      )}
    </div>
  );
}

function ManualDialog({ staff, tz, onClose, onSaved }: { staff: StaffDTO[]; tz: string; onClose: () => void; onSaved: (msg: string) => void }) {
  const today = todayYmd();
  const [form, setForm] = useState({ staff_id: staff[0]?.id ?? "", inAt: `${today}T09:00`, outAt: `${today}T17:00` });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await jsonFetch("/api/workforce/attendance", {
        method: "POST",
        body: JSON.stringify({ staff_id: form.staff_id, clock_in: fromLocalInput(form.inAt, tz), clock_out: form.outAt ? fromLocalInput(form.outAt, tz) : null }),
        fallback: "Could not save attendance",
      });
      onSaved("Attendance recorded.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save attendance");
      setSaving(false);
    }
  }
  return (
    <Dialog title="Manual attendance" description={`Times in ${tz}`} onClose={onClose} size="sm">
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {error && <Banner tone="error">{error}</Banner>}
        <Field label="Who" required>
          <Select value={form.staff_id} onChange={(e) => setForm((f) => ({ ...f, staff_id: e.target.value }))}>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.display_name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Clock in" required>
          <Input type="datetime-local" value={form.inAt} onChange={(e) => setForm((f) => ({ ...f, inAt: e.target.value }))} required />
        </Field>
        <Field label="Clock out" hint="Leave empty for an open timer">
          <Input type="datetime-local" value={form.outAt} onChange={(e) => setForm((f) => ({ ...f, outAt: e.target.value }))} />
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" touch onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" touch disabled={saving || !form.staff_id}>
            {saving && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />} Save
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
