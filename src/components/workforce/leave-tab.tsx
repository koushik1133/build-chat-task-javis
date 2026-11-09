"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarOff, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Banner, Empty, ErrorState, SkeletonList } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { isAbortError, useAbortable } from "@/components/ui/hooks";
import { Input, Select, Textarea } from "@/components/ui/input";
import { StatusPill } from "@/components/ui/pill";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { LEAVE_KINDS, type BalanceDTO, type LeaveDTO, type LeaveKind, type StaffDTO } from "@/lib/workforce/pure";
import type { Notice } from "@/app/(app)/workforce/page";
import { fmtDay, jsonFetch, LEAVE_TONE, todayYmd } from "./shared";

type Filter = "pending" | "approved" | "all";

export function LeaveTab({ staff, notify }: { staff: StaffDTO[]; notify: (tone: Notice["tone"], text: string) => void }) {
  const [filter, setFilter] = useState<Filter>("pending");
  const [leave, setLeave] = useState<LeaveDTO[] | null>(null);
  const [balances, setBalances] = useState<BalanceDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showBalance, setShowBalance] = useState(false);
  const year = Number(todayYmd().slice(0, 4));
  const nextSignal = useAbortable();

  const load = useCallback(async () => {
    const signal = nextSignal();
    setError(null);
    try {
      const [l, b] = await Promise.all([
        jsonFetch<{ leave: LeaveDTO[] }>(`/api/workforce/leave${filter === "all" ? "" : `?status=${filter}`}`, { signal, fallback: "Could not load leave" }),
        jsonFetch<{ balances: BalanceDTO[] }>(`/api/workforce/balances?year=${year}`, { signal, fallback: "Could not load balances" }),
      ]);
      setLeave(l.leave);
      setBalances(b.balances);
    } catch (err) {
      if (isAbortError(err)) return;
      setError(err instanceof Error ? err.message : "Could not load leave");
    }
  }, [filter, year, nextSignal]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(id: string, decision: "approve" | "reject" | "cancel") {
    setBusy(id);
    try {
      await jsonFetch(`/api/workforce/leave/${id}`, { method: "PATCH", body: JSON.stringify({ decision }), fallback: "Could not update request" });
      notify("success", decision === "approve" ? "Leave approved." : decision === "reject" ? "Leave rejected." : "Request cancelled.");
      await load();
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Could not update request");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <section aria-labelledby="leave-requests">
        <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <h3 id="leave-requests" className="text-sm font-semibold">
              Requests
            </h3>
            <Select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label="Filter requests" className="w-auto sm:h-8 sm:text-xs">
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="all">All</option>
            </Select>
          </div>
          <Button size="sm" touch onClick={() => setShowNew(true)} disabled={staff.length === 0}>
            <Plus className="h-4 w-4" aria-hidden /> Request leave
          </Button>
        </div>
        {error ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : leave === null ? (
          <SkeletonList count={4} itemClassName="h-12" label="Loading leave…" />
        ) : leave.length === 0 ? (
          <Empty
            icon={<CalendarOff className="h-6 w-6" aria-hidden />}
            title={filter === "pending" ? "Nothing to approve" : "No leave"}
            text="Requests from crew links and the team appear here."
            action={filter !== "all" ? <Button variant="outline" touch onClick={() => setFilter("all")}>Show all requests</Button> : staff.length > 0 ? <Button variant="outline" touch onClick={() => setShowNew(true)}>Request leave</Button> : undefined}
          />
        ) : (
          <TableScroller label="Leave requests">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className={THEAD}>
                <tr>
                  <th scope="col" className={TH}>Who</th>
                  <th scope="col" className={TH}>Kind</th>
                  <th scope="col" className={TH}>Dates</th>
                  <th scope="col" className={`${TH} text-right`}>Hours</th>
                  <th scope="col" className={TH}>Status</th>
                  <th scope="col" className={TH}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {leave.map((l) => (
                  <tr key={l.id} className="border-t border-border">
                    <td className="px-3 py-2 font-medium">
                      {l.staff_name ?? "Unknown"}
                      {l.note && <div className="max-w-xs truncate text-xs font-normal text-muted-foreground">{l.note}</div>}
                    </td>
                    <td className="px-3 py-2 capitalize text-muted-foreground">{l.kind}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {fmtDay(l.starts_on, { month: "short", day: "numeric" })}
                      {l.ends_on !== l.starts_on && ` – ${fmtDay(l.ends_on, { month: "short", day: "numeric" })}`}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{l.hours}</td>
                    <td className="px-3 py-2">
                      <StatusPill status={l.status} map={LEAVE_TONE} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      {l.status === "pending" && (
                        <span className="inline-flex gap-1">
                          <Button size="sm" touch disabled={busy === l.id} onClick={() => void decide(l.id, "approve")}>
                            {busy === l.id ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : null} Approve
                          </Button>
                          <Button size="sm" variant="outline" touch disabled={busy === l.id} onClick={() => void decide(l.id, "reject")}>
                            Reject
                          </Button>
                        </span>
                      )}
                      {l.status === "approved" && (
                        <Button size="sm" variant="ghost" touch disabled={busy === l.id} onClick={() => void decide(l.id, "cancel")}>
                          Cancel
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
        )}
      </section>

      <section aria-labelledby="leave-balances">
        <div className="mb-3 flex items-center justify-between">
          <h3 id="leave-balances" className="text-sm font-semibold">
            Balances {year}
          </h3>
          <Button size="sm" variant="outline" touch onClick={() => setShowBalance(true)} disabled={staff.length === 0}>
            Set allotment
          </Button>
        </div>
        {balances === null ? (
          <SkeletonList count={3} itemClassName="h-10" label="Loading balances…" />
        ) : balances.length === 0 ? (
          <Empty title="No allotments yet" text="Without one, paid leave is approved without a cap." className="py-6" action={staff.length > 0 ? <Button size="sm" variant="outline" touch onClick={() => setShowBalance(true)}>Set allotment</Button> : undefined} />
        ) : (
          <TableScroller label="Leave balances">
            <table className="w-full min-w-[30rem] text-sm">
              <thead className={THEAD}>
                <tr>
                  <th scope="col" className={TH}>Who</th>
                  <th scope="col" className={TH}>Kind</th>
                  <th scope="col" className={`${TH} text-right`}>Allotted</th>
                  <th scope="col" className={`${TH} text-right`}>Used</th>
                  <th scope="col" className={`${TH} text-right`}>Remaining</th>
                </tr>
              </thead>
              <tbody>
                {balances.map((b) => (
                  <tr key={`${b.staff_id}-${b.kind}`} className="border-t border-border">
                    <td className="px-3 py-2 font-medium">{b.staff_name ?? b.staff_id}</td>
                    <td className="px-3 py-2 capitalize text-muted-foreground">{b.kind}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{b.allotted_hours}h</td>
                    <td className="px-3 py-2 text-right tabular-nums">{b.used_hours}h</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      <span className={b.remaining_hours <= 8 ? "text-amber-600 dark:text-amber-400" : ""}>{b.remaining_hours <= 8 && <span className="sr-only">Running low: </span>}{b.remaining_hours}h</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
        )}
      </section>

      {showNew && (
        <LeaveDialog
          staff={staff}
          onClose={() => setShowNew(false)}
          onSaved={(msg) => {
            setShowNew(false);
            notify("success", msg);
            void load();
          }}
        />
      )}
      {showBalance && (
        <BalanceDialog
          staff={staff}
          year={year}
          onClose={() => setShowBalance(false)}
          onSaved={(msg) => {
            setShowBalance(false);
            notify("success", msg);
            void load();
          }}
        />
      )}
    </div>
  );
}

function LeaveDialog({ staff, onClose, onSaved }: { staff: StaffDTO[]; onClose: () => void; onSaved: (msg: string) => void }) {
  const today = todayYmd();
  const [form, setForm] = useState({ staff_id: staff[0]?.id ?? "", kind: "vacation" as LeaveKind, starts_on: today, ends_on: today, hours: "", note: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await jsonFetch("/api/workforce/leave", {
        method: "POST",
        body: JSON.stringify({ staff_id: form.staff_id, kind: form.kind, starts_on: form.starts_on, ends_on: form.ends_on, ...(form.hours ? { hours: Number(form.hours) } : {}), note: form.note.trim() || null }),
        fallback: "Could not request leave",
      });
      onSaved("Leave requested.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not request leave");
      setSaving(false);
    }
  }
  return (
    <Dialog title="Request leave" onClose={onClose} size="sm">
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {error && <Banner tone="error">{error}</Banner>}
        <Field label="Who" required>
          <Select value={form.staff_id} onChange={(e) => set("staff_id", e.target.value)} required>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.display_name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Kind">
          <Select value={form.kind} onChange={(e) => set("kind", e.target.value as LeaveKind)}>
            {LEAVE_KINDS.map((k) => (
              <option key={k} value={k} className="capitalize">
                {k[0].toUpperCase() + k.slice(1)}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From" required>
            <Input type="date" value={form.starts_on} onChange={(e) => set("starts_on", e.target.value)} required />
          </Field>
          <Field label="To" required>
            <Input type="date" value={form.ends_on} min={form.starts_on} onChange={(e) => set("ends_on", e.target.value)} required />
          </Field>
        </div>
        <Field label="Hours" hint="Leave blank to use weekdays × daily hours">
          <Input type="number" inputMode="numeric" min={0} max={2000} value={form.hours} onChange={(e) => set("hours", e.target.value)} />
        </Field>
        <Field label="Note">
          <Textarea rows={2} value={form.note} onChange={(e) => set("note", e.target.value)} maxLength={2000} />
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" touch onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" touch disabled={saving || !form.staff_id}>
            {saving && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />} Request
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function BalanceDialog({ staff, year, onClose, onSaved }: { staff: StaffDTO[]; year: number; onClose: () => void; onSaved: (msg: string) => void }) {
  const [form, setForm] = useState({ staff_id: staff[0]?.id ?? "", kind: "vacation" as LeaveKind, year, allotted_hours: 160 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await jsonFetch("/api/workforce/balances", { method: "PUT", body: JSON.stringify(form), fallback: "Could not save allotment" });
      onSaved("Allotment saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save allotment");
      setSaving(false);
    }
  }
  return (
    <Dialog title="Set leave allotment" description="Hours available per year for one kind of leave." onClose={onClose} size="sm">
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
        <div className="grid grid-cols-3 gap-3">
          <Field label="Kind">
            <Select value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as LeaveKind }))}>
              {LEAVE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k[0].toUpperCase() + k.slice(1)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Year">
            <Input type="number" inputMode="numeric" min={2000} max={2100} value={form.year} onChange={(e) => setForm((f) => ({ ...f, year: Number(e.target.value) }))} />
          </Field>
          <Field label="Hours">
            <Input type="number" inputMode="numeric" min={0} max={10000} value={form.allotted_hours} onChange={(e) => setForm((f) => ({ ...f, allotted_hours: Number(e.target.value) }))} />
          </Field>
        </div>
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
