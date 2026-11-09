"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, Loader2, Pause, Pencil, Play, Plus, Trash2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Pill, type Tone } from "@/components/ui/pill";
import { Input, Select, Textarea, Checkbox } from "@/components/ui/input";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Banner, Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { isAbortError, useAbortable } from "@/components/ui/hooks";
import { fmtDate, fmtMoney } from "@/lib/money/format";
import { previewRuns, SCHEDULE_INTERVALS, type ScheduleInterval } from "@/lib/money/cadence";
import { BLANK_ITEM, LineItemsEditor, TotalsSummary, useDocTotals, useTaxRates, type LineItem } from "./shared";

interface Contact { id: string; full_name: string; email: string | null; company: string | null }
export interface Schedule {
  id: string; name: string; contact_id: string | null; contact_name: string | null; contact_email: string | null;
  items: LineItem[]; currency: string; interval: ScheduleInterval; interval_count: number; day_of_month: number | null;
  next_run_at: string; end_at: string | null; auto_send: boolean; terms_days: number | null; notes: string | null;
  status: "active" | "paused" | "ended"; last_invoice_id: string | null; last_run_at: string | null; run_count: number;
}

const STATUS_TONE: Record<Schedule["status"], Tone> = { active: "success", paused: "warning", ended: "neutral" };
const spinner = <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.detail?.formErrors?.[0] ?? (typeof data?.detail === "string" ? data.detail : null) ?? data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

function cadenceLabel(s: Pick<Schedule, "interval" | "interval_count" | "day_of_month">): string {
  const unit = s.interval === "weekly" ? "week" : s.interval === "monthly" ? "month" : s.interval === "quarterly" ? "quarter" : "year";
  const every = s.interval_count === 1 ? `Every ${unit}` : `Every ${s.interval_count} ${unit}s`;
  return s.day_of_month && s.interval !== "weekly" ? `${every} on day ${s.day_of_month}` : every;
}

export function RecurringTab({ onNotice, onInvoiceCreated }: { onNotice: (n: { tone: "success" | "info" | "error"; text: string }) => void; onInvoiceCreated: () => void }) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | { mode: "create" } | { mode: "edit"; schedule: Schedule }>(null);
  const nextSignal = useAbortable();

  const load = useCallback(async () => {
    const signal = nextSignal();
    setLoading(true);
    setError(null);
    try {
      const r = await api<{ schedules: Schedule[] }>("/api/invoice-schedules", { signal });
      setSchedules(r.schedules);
    } catch (e) {
      if (isAbortError(e)) return;
      setError(e instanceof Error ? e.message : "Could not load schedules.");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [nextSignal]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (id: string, fn: () => Promise<string | void>) => {
      setBusyId(id);
      try {
        const msg = await fn();
        if (msg) onNotice({ tone: "success", text: msg });
        await load();
      } catch (e) {
        onNotice({ tone: "error", text: e instanceof Error ? e.message : "Action failed." });
      } finally {
        setBusyId(null);
      }
    },
    [load, onNotice]
  );

  return (
    <div aria-busy={loading || undefined}>
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">Invoices created automatically on a cadence. Pause any time; Run now creates the next one immediately.</p>
        <Button touch size="sm" className="self-start sm:self-auto" onClick={() => setDialog({ mode: "create" })}>
          <Plus className="h-4 w-4" aria-hidden /> New schedule
        </Button>
      </div>
      {loading && schedules.length === 0 ? (
        <Loading label="Loading schedules…" className="rounded-xl border border-border bg-card" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : schedules.length === 0 ? (
        <Empty
          icon={<CalendarClock className="h-5 w-5" />}
          title="No recurring invoices"
          text="Set up a retainer, subscription or maintenance plan and the invoice goes out on schedule."
          action={
            <Button touch onClick={() => setDialog({ mode: "create" })}>
              <Plus className="h-4 w-4" aria-hidden /> New schedule
            </Button>
          }
        />
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card" aria-label="Recurring invoice schedules">
          {schedules.map((s) => {
            const busy = busyId === s.id;
            const total = s.items.reduce((acc, it) => acc + Math.floor(it.qty * it.unit_minor + 0.5), 0);
            return (
              <li key={s.id} className="flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center lg:justify-between" aria-busy={busy || undefined}>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{s.name}</span>
                    <Pill tone={STATUS_TONE[s.status]} className="capitalize">{s.status}</Pill>
                    {s.auto_send && <Pill tone="info">Auto-send</Pill>}
                  </div>
                  <p className="mt-0.5 truncate text-sm text-muted-foreground">
                    {s.contact_name ?? "No contact"} · {cadenceLabel(s)} · {s.status === "ended" ? "ended" : `next ${fmtDate(s.next_run_at)}`} · {s.run_count} run{s.run_count === 1 ? "" : "s"}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="mr-1 font-medium tabular-nums">{fmtMoney(total, s.currency)}<span className="text-xs font-normal text-muted-foreground"> net</span></span>
                  {s.status === "active" && (
                    <Button size="sm" variant="outline" touch disabled={busy} title="Create the next invoice now" onClick={() => act(s.id, async () => {
                      const r = await api<{ result: { invoice_id: string | null; sent: boolean } }>(`/api/invoice-schedules/${s.id}/run`, { method: "POST" });
                      onInvoiceCreated();
                      return r.result.sent ? "Invoice created and sent." : "Invoice created as a draft.";
                    })}>
                      <Zap className="h-3.5 w-3.5" aria-hidden /> Run now
                    </Button>
                  )}
                  {s.status !== "ended" && (
                    <Button size="sm" variant="outline" touch disabled={busy} onClick={() => act(s.id, async () => {
                      const status = s.status === "active" ? "paused" : "active";
                      await api(`/api/invoice-schedules/${s.id}`, { method: "PATCH", body: JSON.stringify({ status }) });
                      return status === "paused" ? `Paused ${s.name}.` : `Resumed ${s.name}.`;
                    })}>
                      {s.status === "active" ? <Pause className="h-3.5 w-3.5" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />} {s.status === "active" ? "Pause" : "Resume"}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" touch disabled={busy} onClick={() => setDialog({ mode: "edit", schedule: s })} aria-label={`Edit ${s.name}`}>
                    <Pencil className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                  <Button size="sm" variant="ghost" touch disabled={busy} aria-label={`Delete ${s.name}`} onClick={() => {
                    if (!window.confirm(`Delete schedule "${s.name}"? Existing invoices are kept.`)) return;
                    void act(s.id, async () => {
                      await api(`/api/invoice-schedules/${s.id}`, { method: "DELETE" });
                      return `Deleted ${s.name}.`;
                    });
                  }}>
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                  {busy && <span role="status" className="inline-flex items-center">{spinner}<span className="sr-only">Working…</span></span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {dialog && (
        <ScheduleDialog
          schedule={dialog.mode === "edit" ? dialog.schedule : null}
          onClose={() => setDialog(null)}
          onSaved={(msg) => {
            setDialog(null);
            onNotice({ tone: "success", text: msg });
            void load();
          }}
        />
      )}
    </div>
  );
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function ScheduleDialog({ schedule, onClose, onSaved }: { schedule: Schedule | null; onClose: () => void; onSaved: (msg: string) => void }) {
  const { rates, inclusive, rounding } = useTaxRates();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [name, setName] = useState(schedule?.name ?? "");
  const [contactId, setContactId] = useState(schedule?.contact_id ?? "");
  const [currency, setCurrency] = useState(schedule?.currency ?? "USD");
  const [items, setItems] = useState<LineItem[]>(schedule?.items.length ? schedule.items : [{ ...BLANK_ITEM }]);
  const [interval, setInterval_] = useState<ScheduleInterval>(schedule?.interval ?? "monthly");
  const [count, setCount] = useState(schedule?.interval_count ?? 1);
  const [dayOfMonth, setDayOfMonth] = useState<string>(schedule?.day_of_month ? String(schedule.day_of_month) : "");
  const [start, setStart] = useState(schedule ? toLocalInput(schedule.next_run_at) : toLocalInput(new Date().toISOString()));
  const [end, setEnd] = useState(schedule?.end_at ? toLocalInput(schedule.end_at) : "");
  const [autoSend, setAutoSend] = useState(schedule?.auto_send ?? false);
  const [terms, setTerms] = useState<string>(schedule?.terms_days != null ? String(schedule.terms_days) : "");
  const [notes, setNotes] = useState(schedule?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const totalOpts = useMemo(() => ({ inclusive, rounding }), [inclusive, rounding]);
  const totals = useDocTotals(items, rates, totalOpts);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/crm/contacts?limit=200", { signal: ctrl.signal })
      .then((r) => r.json())
      .then((d) => setContacts(d.contacts ?? []))
      .catch(() => setContacts([]));
    return () => ctrl.abort();
  }, []);

  const startIso = start ? new Date(`${start}T09:00:00`).toISOString() : null;
  const preview = useMemo(() => {
    if (!startIso) return [];
    return previewRuns(new Date(startIso), interval, count, dayOfMonth ? Number(dayOfMonth) : null, 3, end ? new Date(`${end}T23:59:59`) : null);
  }, [startIso, interval, count, dayOfMonth, end]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const clean = items.filter((it) => it.description.trim());
      if (clean.length === 0) throw new Error("Add at least one line item.");
      if (!startIso) throw new Error("Pick a first run date.");
      const body = {
        name,
        contact_id: contactId || null,
        currency,
        items: clean,
        interval,
        interval_count: count,
        day_of_month: dayOfMonth ? Number(dayOfMonth) : null,
        next_run_at: startIso,
        end_at: end ? new Date(`${end}T23:59:59`).toISOString() : null,
        auto_send: autoSend,
        terms_days: terms === "" ? null : Number(terms),
        notes: notes || null,
      };
      if (schedule) {
        await api(`/api/invoice-schedules/${schedule.id}`, { method: "PATCH", body: JSON.stringify(body) });
        onSaved(`Updated ${name}.`);
      } else {
        await api("/api/invoice-schedules", { method: "POST", body: JSON.stringify(body) });
        onSaved(`Created schedule ${name}.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title={schedule ? "Edit schedule" : "New recurring invoice"} onClose={onClose} size="lg">
      <form onSubmit={submit} className="space-y-4">
        {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Name" className="sm:col-span-2">
            <Input required value={name} maxLength={120} placeholder="Monthly retainer" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Currency" hint="Three-letter code">
            <Input value={currency} maxLength={3} autoCapitalize="characters" onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
          </Field>
          <Field label="Contact" className="sm:col-span-3">
            <Select value={contactId} onChange={(e) => setContactId(e.target.value)}>
              <option value="">No contact</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>{c.full_name}{c.company ? ` (${c.company})` : ""}{c.email ? ` · ${c.email}` : ""}</option>
              ))}
            </Select>
          </Field>
          <Field label="Repeats">
            <Select value={interval} onChange={(e) => setInterval_(e.target.value as ScheduleInterval)}>
              {SCHEDULE_INTERVALS.map((i) => <option key={i} value={i}>{i.charAt(0).toUpperCase() + i.slice(1)}</option>)}
            </Select>
          </Field>
          <Field label="Every">
            <Input type="number" min={1} max={52} value={count} onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))} />
          </Field>
          <Field label="Day of month" hint="Blank = anchor date; clamps to month end">
            <Input type="number" min={1} max={31} value={dayOfMonth} disabled={interval === "weekly"} onChange={(e) => setDayOfMonth(e.target.value)} />
          </Field>
          <Field label="First run">
            <Input type="date" required value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="Ends" hint="Optional">
            <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
          <Field label="Payment terms (days)" hint="Blank = org default">
            <Input type="number" min={0} max={365} value={terms} onChange={(e) => setTerms(e.target.value)} />
          </Field>
        </div>
        {preview.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Next runs: {preview.map((d) => fmtDate(d.toISOString())).join(" → ")}
          </p>
        )}
        <LineItemsEditor items={items} onChange={setItems} rates={rates} currency={currency} />
        <Field label="Notes" hint="Printed on every invoice">
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <Checkbox label="Email each invoice to the contact automatically" checked={autoSend} onChange={(e) => setAutoSend(e.target.checked)} />
        <DialogFooter start={<TotalsSummary totals={totals} currency={currency} inclusive={inclusive} />}>
          <Button type="button" variant="ghost" touch onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="submit" touch disabled={saving}>{saving && spinner} {schedule ? "Save" : "Create schedule"}</Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
