"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Clock, FileDiff, Loader2, Pencil, Play, Plus, Receipt, RefreshCw, Square, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/input";
import { Pill, StatusPill } from "@/components/ui/pill";
import { PageContainer } from "@/components/page-container";
import { LoadMore } from "@/components/ui/load-more";
import { cn } from "@/lib/utils";
import { fmtDate, fmtMoney } from "@/lib/money/format";
import { computeTotalsClient, type LineItem } from "@/components/billing/shared";
import { api, Banner, Dialog, DialogFooter, Empty, Field, fmtMinutes, fmtTime, fromMinor, Loading, TabPanel, Tabs, todayLocalISODate, toMinor } from "@/components/finance/shared";

interface Expense {
  id: string; category: string; vendor: string | null; description: string | null; amount_minor: number; tax_minor: number; total_minor: number; currency: string;
  spent_at: string; receipt_url: string | null; ref_kind: string | null; ref_id: string | null; billable: boolean; invoice_id: string | null;
}
interface TimeEntry {
  id: string; member_id: string | null; ref_kind: string | null; ref_id: string | null; description: string | null; started_at: string; ended_at: string | null;
  minutes: number | null; running: boolean; rate_minor: number; currency: string; value_minor: number; billable: boolean; invoice_id: string | null;
}
interface ChangeOrder {
  id: string; quote_id: string | null; invoice_id: string | null; number: number; label: string; title: string; description: string | null;
  items: LineItem[]; delta_minor: number; currency: string; status: "draft" | "sent" | "accepted" | "rejected"; accepted_at: string | null; created_at: string;
}
interface Doc { id: string; number: string; status: string; currency: string; contact_name: string | null }
type Docs = { quotes: Doc[]; invoices: Doc[] };
type DocLabel = (kind: string | null, id: string | null) => string | null;

type Tab = "expenses" | "time" | "change-orders";
const CATEGORIES = ["general", "materials", "subcontractor", "travel", "fuel", "equipment", "software", "marketing", "meals", "fees", "other"];
const REF_KINDS = [["", "No job"], ["invoice", "Invoice"], ["quote", "Quote"], ["booking", "Booking"], ["record", "Record"]] as const;
const spinner = <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />;

export default function FinancePage() {
  const [tab, setTab] = useState<Tab>("expenses");
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [time, setTime] = useState<TimeEntry[]>([]);
  const [expenseCursor, setExpenseCursor] = useState<string | null>(null);
  const [timeCursor, setTimeCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState<"expenses" | "time" | null>(null);
  const [cos, setCos] = useState<ChangeOrder[]>([]);
  const [docs, setDocs] = useState<Docs>({ quotes: [], invoices: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expenseDialog, setExpenseDialog] = useState<Expense | "new" | null>(null);
  const [timeDialog, setTimeDialog] = useState<TimeEntry | "new" | null>(null);
  const [coDialog, setCoDialog] = useState<ChangeOrder | "new" | null>(null);
  const router = useRouter();

  // Deep link from Home quick actions: /finance?timer=start opens the Time tab with the timer dialog, then the URL is cleaned.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("timer") !== "start") return;
    setTab("time");
    setTimeDialog("new");
    router.replace("/finance", { scroll: false });
  }, [router]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [e, t, c, q, i] = await Promise.all([
        api<{ expenses: Expense[]; next_cursor: string | null }>("/api/expenses?order=created&limit=50"),
        api<{ entries: TimeEntry[]; next_cursor: string | null }>("/api/time?order=created&limit=50"),
        api<{ change_orders: ChangeOrder[] }>("/api/change-orders"),
        api<{ quotes: Doc[] }>("/api/quotes").catch(() => ({ quotes: [] as Doc[] })),
        api<{ invoices: Doc[] }>("/api/invoices").catch(() => ({ invoices: [] as Doc[] })),
      ]);
      setExpenses(e.expenses);
      setExpenseCursor(e.next_cursor ?? null);
      setTime(t.entries);
      setTimeCursor(t.next_cursor ?? null);
      setCos(c.change_orders);
      setDocs({ quotes: q.quotes, invoices: i.invoices });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load finance data.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const moreExpenses = useCallback(async () => {
    if (!expenseCursor || loadingMore) return;
    setLoadingMore("expenses");
    try {
      const e = await api<{ expenses: Expense[]; next_cursor: string | null }>(`/api/expenses?order=created&limit=50&cursor=${encodeURIComponent(expenseCursor)}`);
      setExpenses((prev) => {
        const seen = new Set(prev.map((x) => x.id));
        return [...prev, ...e.expenses.filter((x) => !seen.has(x.id))];
      });
      setExpenseCursor(e.next_cursor ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load more expenses.");
    } finally {
      setLoadingMore(null);
    }
  }, [expenseCursor, loadingMore]);

  const moreTime = useCallback(async () => {
    if (!timeCursor || loadingMore) return;
    setLoadingMore("time");
    try {
      const t = await api<{ entries: TimeEntry[]; next_cursor: string | null }>(`/api/time?order=created&limit=50&cursor=${encodeURIComponent(timeCursor)}`);
      setTime((prev) => {
        const seen = new Set(prev.map((x) => x.id));
        return [...prev, ...t.entries.filter((x) => !seen.has(x.id))];
      });
      setTimeCursor(t.next_cursor ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load more time entries.");
    } finally {
      setLoadingMore(null);
    }
  }, [timeCursor, loadingMore]);

  const act = useCallback(
    async (id: string, fn: () => Promise<string | void>) => {
      setBusyId(id);
      setError(null);
      setNotice(null);
      try {
        const msg = await fn();
        if (msg) setNotice(msg);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "That didn’t work. Try again.");
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  const running = useMemo(() => time.find((t) => t.running) ?? null, [time]);
  const docLabel = useCallback<DocLabel>(
    (kind, id) => {
      if (!kind || !id) return null;
      const d = kind === "invoice" ? docs.invoices.find((x) => x.id === id) : kind === "quote" ? docs.quotes.find((x) => x.id === id) : null;
      return d ? `${d.number}${d.contact_name ? ` · ${d.contact_name}` : ""}` : `${kind} ${id.slice(0, 8)}`;
    },
    [docs]
  );

  const stopTimer = useCallback(
    (t: TimeEntry) =>
      act(t.id, async () => {
        const r = await api<{ entry: TimeEntry }>(`/api/time?id=${encodeURIComponent(t.id)}`, { method: "PATCH" });
        return `Timer stopped at ${fmtMinutes(r.entry.minutes)}.`;
      }),
    [act]
  );
  const onEditExpense = useCallback((e: Expense) => setExpenseDialog(e), []);
  const onDeleteExpense = useCallback(
    (e: Expense) => {
      if (!window.confirm("Delete this expense?")) return;
      void act(e.id, async () => {
        await api(`/api/expenses/${e.id}`, { method: "DELETE" });
        return "Expense deleted.";
      });
    },
    [act]
  );
  const onEditTime = useCallback((t: TimeEntry) => setTimeDialog(t), []);
  const onDeleteTime = useCallback(
    (t: TimeEntry) => {
      if (!window.confirm("Delete this time entry?")) return;
      void act(t.id, async () => {
        await api(`/api/time/${t.id}`, { method: "DELETE" });
        return "Time entry deleted.";
      });
    },
    [act]
  );
  const onEditCo = useCallback((c: ChangeOrder) => setCoDialog(c), []);
  const onStatusCo = useCallback(
    (co: ChangeOrder, status: ChangeOrder["status"]) =>
      act(co.id, async () => {
        const r = await api<{ change_order: ChangeOrder; invoice?: { number: string } }>(`/api/change-orders/${co.id}`, { method: "PATCH", body: JSON.stringify({ status }) });
        return status === "accepted" ? `${co.label} accepted${r.invoice ? ` and billed on ${r.invoice.number}` : ""}.` : `${co.label} marked ${status}.`;
      }),
    [act]
  );
  const onDeleteCo = useCallback(
    (co: ChangeOrder) => {
      if (!window.confirm(`Delete ${co.label}?`)) return;
      void act(co.id, async () => {
        await api(`/api/change-orders/${co.id}`, { method: "DELETE" });
        return `${co.label} deleted.`;
      });
    },
    [act]
  );

  const newLabel = tab === "expenses" ? "Log expense" : tab === "time" ? "Log time" : "New change order";
  const openNew = () => (tab === "expenses" ? setExpenseDialog("new") : tab === "time" ? setTimeDialog("new") : setCoDialog("new"));
  const initial = loading && expenses.length === 0 && time.length === 0 && cos.length === 0;

  return (
    <PageContainer
      wide
      title="Finance"
      description="Expenses you paid, hours you worked, and scope changes you priced — all tied to jobs so you can see what each one really made."
      tooltip="Billable expenses and time can be added to a draft invoice from Billing. Accepting a change order bills its lines automatically."
      actions={
        <>
          <Button variant="outline" size="icon" touch onClick={() => void load()} disabled={loading} aria-label="Refresh">
            {loading ? spinner : <RefreshCw className="h-4 w-4" aria-hidden />}
          </Button>
          <Button touch onClick={openNew}>
            <Plus className="h-4 w-4" aria-hidden /> {newLabel}
          </Button>
        </>
      }
    >
      <div className="mb-4">
        <Tabs
          id="finance"
          label="Finance sections"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "expenses", label: "Expenses", count: expenses.length },
            { id: "time", label: "Time", count: time.length },
            { id: "change-orders", label: "Change orders", count: cos.length },
          ]}
        />
      </div>

      {error && (
        <Banner tone="error" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}
      {notice && (
        <Banner tone="success" onDismiss={() => setNotice(null)}>
          {notice}
        </Banner>
      )}

      {tab === "time" && (
        <TimerBar running={running} busy={busyId === (running?.id ?? "start")} onStart={() => setTimeDialog("new")} onStop={() => running && void stopTimer(running)} />
      )}

      <TabPanel id="finance" value={tab}>
        {initial ? (
          <Loading />
        ) : tab === "expenses" ? (
          <>
            <ExpenseList expenses={expenses} busyId={busyId} docLabel={docLabel} onEdit={onEditExpense} onDelete={onDeleteExpense} onNew={() => setExpenseDialog("new")} />
            {expenses.length > 0 && <LoadMore hasMore={Boolean(expenseCursor)} loading={loadingMore === "expenses"} count={expenses.length} onMore={moreExpenses} noun="expenses" />}
          </>
        ) : tab === "time" ? (
          <>
            <TimeList entries={time} busyId={busyId} docLabel={docLabel} onEdit={onEditTime} onStop={stopTimer} onDelete={onDeleteTime} onNew={() => setTimeDialog("new")} />
            {time.length > 0 && <LoadMore hasMore={Boolean(timeCursor)} loading={loadingMore === "time"} count={time.length} onMore={moreTime} noun="time entries" />}
          </>
        ) : (
          <ChangeOrderList cos={cos} busyId={busyId} docLabel={docLabel} onEdit={onEditCo} onStatus={onStatusCo} onDelete={onDeleteCo} onNew={() => setCoDialog("new")} />
        )}
      </TabPanel>

      {expenseDialog && (
        <ExpenseDialog
          expense={expenseDialog === "new" ? null : expenseDialog}
          docs={docs}
          onClose={() => setExpenseDialog(null)}
          onSaved={(m) => {
            setExpenseDialog(null);
            setNotice(m);
            void load();
          }}
        />
      )}
      {timeDialog && (
        <TimeDialog
          entry={timeDialog === "new" ? null : timeDialog}
          docs={docs}
          hasRunning={Boolean(running)}
          onClose={() => setTimeDialog(null)}
          onSaved={(m) => {
            setTimeDialog(null);
            setNotice(m);
            void load();
          }}
        />
      )}
      {coDialog && (
        <ChangeOrderDialog
          co={coDialog === "new" ? null : coDialog}
          docs={docs}
          onClose={() => setCoDialog(null)}
          onSaved={(m) => {
            setCoDialog(null);
            setNotice(m);
            void load();
          }}
        />
      )}
    </PageContainer>
  );
}

/* ── Timer ──────────────────────────────────────────────────────────────── */

function useElapsed(startedAt: string | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt]);
  return startedAt ? Math.max(0, now - new Date(startedAt).getTime()) : 0;
}

function fmtClock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function TimerBar({ running, busy, onStart, onStop }: { running: TimeEntry | null; busy: boolean; onStart: () => void; onStop: () => void }) {
  const elapsed = useElapsed(running?.started_at ?? null);
  return (
    <div
      className={cn("mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3", running ? "border-primary/40 bg-accent" : "border-border bg-card")}
      role="region"
      aria-label="Timer"
    >
      <div className="flex items-center gap-3">
        <Clock className={cn("h-5 w-5", running ? "text-primary" : "text-muted-foreground")} aria-hidden />
        <div>
          <p className="font-mono text-xl tabular-nums" aria-live="off">
            {fmtClock(elapsed)}
          </p>
          <p className="text-xs text-muted-foreground">{running ? `${running.description || "Timer running"} · since ${fmtTime(running.started_at)}` : "No timer running"}</p>
        </div>
      </div>
      {running ? (
        <Button variant="destructive" touch onClick={onStop} disabled={busy}>
          {busy ? spinner : <Square className="h-4 w-4" aria-hidden />} Stop
        </Button>
      ) : (
        <Button touch onClick={onStart} disabled={busy}>
          <Play className="h-4 w-4" aria-hidden /> Start timer
        </Button>
      )}
    </div>
  );
}

/* ── Lists ───────────────────────────────────────────────────────────────── */

function BillingPills({ billable, invoiceId }: { billable: boolean; invoiceId: string | null }) {
  if (invoiceId) return <Pill tone="success">Invoiced</Pill>;
  if (billable) return <Pill tone="info">Billable</Pill>;
  return null;
}

const ROW = "flex flex-wrap items-center justify-between gap-3 px-4 py-3";
const LIST = "divide-y divide-border rounded-lg border border-border bg-card";

function ExpenseList({ expenses, busyId, docLabel, onEdit, onDelete, onNew }: { expenses: Expense[]; busyId: string | null; docLabel: DocLabel; onEdit: (e: Expense) => void; onDelete: (e: Expense) => void; onNew: () => void }) {
  if (expenses.length === 0) {
    return (
      <Empty
        icon={<Receipt className="h-5 w-5" />}
        title="No expenses logged"
        text="Record materials, subcontractors, travel — anything you paid for a job."
        action={
          <Button onClick={onNew}>
            <Plus className="h-4 w-4" aria-hidden /> Log expense
          </Button>
        }
      />
    );
  }
  return (
    <ul className={LIST}>
      {expenses.map((e) => (
        <ExpenseRow key={e.id} e={e} busy={busyId === e.id} job={docLabel(e.ref_kind, e.ref_id)} onEdit={onEdit} onDelete={onDelete} />
      ))}
    </ul>
  );
}

const ExpenseRow = memo(function ExpenseRow({ e, busy, job, onEdit, onDelete }: { e: Expense; busy: boolean; job: string | null; onEdit: (e: Expense) => void; onDelete: (e: Expense) => void }) {
  return (
    <li className={ROW} aria-busy={busy || undefined}>
      <div className="min-w-0">
        <p className="truncate font-medium">{e.vendor || e.description || e.category}</p>
        <p className="truncate text-sm text-muted-foreground">
          <span className="capitalize">{e.category}</span> · {fmtDate(e.spent_at)}
          {e.vendor && e.description ? ` · ${e.description}` : ""}
          {job ? ` · ${job}` : ""}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <BillingPills billable={e.billable} invoiceId={e.invoice_id} />
        <span className="font-medium tabular-nums">{fmtMoney(e.total_minor, e.currency)}</span>
        {e.receipt_url && (
          <a href={e.receipt_url} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center rounded text-xs underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0">
            Receipt<span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}
        <Button size="icon-sm" variant="ghost" touch disabled={busy} onClick={() => onEdit(e)} aria-label="Edit expense">
          <Pencil className="h-3.5 w-3.5" aria-hidden />
        </Button>
        {!e.invoice_id && (
          <Button size="icon-sm" variant="ghost" touch disabled={busy} onClick={() => onDelete(e)} aria-label="Delete expense">
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          </Button>
        )}
        {busy && spinner}
      </div>
    </li>
  );
});

function TimeList({ entries, busyId, docLabel, onEdit, onStop, onDelete, onNew }: { entries: TimeEntry[]; busyId: string | null; docLabel: DocLabel; onEdit: (t: TimeEntry) => void; onStop: (t: TimeEntry) => void; onDelete: (t: TimeEntry) => void; onNew: () => void }) {
  if (entries.length === 0) {
    return (
      <Empty
        icon={<Clock className="h-5 w-5" />}
        title="No time logged"
        text="Start the timer or log hours against a job to cost your labour."
        action={
          <Button onClick={onNew}>
            <Play className="h-4 w-4" aria-hidden /> Log time
          </Button>
        }
      />
    );
  }
  return (
    <ul className={LIST}>
      {entries.map((t) => (
        <TimeRow key={t.id} t={t} busy={busyId === t.id} job={docLabel(t.ref_kind, t.ref_id)} onEdit={onEdit} onStop={onStop} onDelete={onDelete} />
      ))}
    </ul>
  );
}

const TimeRow = memo(function TimeRow({ t, busy, job, onEdit, onStop, onDelete }: { t: TimeEntry; busy: boolean; job: string | null; onEdit: (t: TimeEntry) => void; onStop: (t: TimeEntry) => void; onDelete: (t: TimeEntry) => void }) {
  return (
    <li className={cn(ROW, t.running && "bg-accent/60")} aria-busy={busy || undefined}>
      <div className="min-w-0">
        <p className="truncate font-medium">
          {t.description || "Work"}
          {t.running && (
            <Pill tone="accent" className="ml-2">
              Running
            </Pill>
          )}
        </p>
        <p className="truncate text-sm text-muted-foreground">
          {fmtDate(t.started_at)} {fmtTime(t.started_at)}
          {t.ended_at && `–${fmtTime(t.ended_at)}`}
          {job ? ` · ${job}` : ""}
          {t.rate_minor > 0 && ` · ${fmtMoney(t.rate_minor, t.currency)}/h`}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {!t.running && <BillingPills billable={t.billable} invoiceId={t.invoice_id} />}
        <span className="font-medium tabular-nums">{t.running ? "—" : fmtMinutes(t.minutes)}</span>
        {!t.running && t.value_minor > 0 && <span className="text-sm tabular-nums text-muted-foreground">{fmtMoney(t.value_minor, t.currency)}</span>}
        {t.running && (
          <Button size="sm" variant="outline" touch disabled={busy} onClick={() => onStop(t)}>
            <Square className="h-3.5 w-3.5" aria-hidden /> Stop
          </Button>
        )}
        <Button size="icon-sm" variant="ghost" touch disabled={busy} onClick={() => onEdit(t)} aria-label="Edit time entry">
          <Pencil className="h-3.5 w-3.5" aria-hidden />
        </Button>
        {!t.invoice_id && (
          <Button size="icon-sm" variant="ghost" touch disabled={busy} onClick={() => onDelete(t)} aria-label="Delete time entry">
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          </Button>
        )}
        {busy && spinner}
      </div>
    </li>
  );
});

function ChangeOrderList({ cos, busyId, docLabel, onEdit, onStatus, onDelete, onNew }: {
  cos: ChangeOrder[]; busyId: string | null; docLabel: DocLabel;
  onEdit: (c: ChangeOrder) => void; onStatus: (c: ChangeOrder, s: ChangeOrder["status"]) => void; onDelete: (c: ChangeOrder) => void; onNew: () => void;
}) {
  if (cos.length === 0) {
    return (
      <Empty
        icon={<FileDiff className="h-5 w-5" />}
        title="No change orders"
        text="When the scope grows, price the extra work here. Accepting it bills the client automatically."
        action={
          <Button onClick={onNew}>
            <Plus className="h-4 w-4" aria-hidden /> New change order
          </Button>
        }
      />
    );
  }
  return (
    <ul className={LIST}>
      {cos.map((co) => (
        <ChangeOrderRow key={co.id} co={co} busy={busyId === co.id} link={docLabel("invoice", co.invoice_id) ?? docLabel("quote", co.quote_id)} onEdit={onEdit} onStatus={onStatus} onDelete={onDelete} />
      ))}
    </ul>
  );
}

const ChangeOrderRow = memo(function ChangeOrderRow({ co, busy, link, onEdit, onStatus, onDelete }: {
  co: ChangeOrder; busy: boolean; link: string | null;
  onEdit: (c: ChangeOrder) => void; onStatus: (c: ChangeOrder, s: ChangeOrder["status"]) => void; onDelete: (c: ChangeOrder) => void;
}) {
  const open = co.status === "draft" || co.status === "sent";
  return (
    <li className={ROW} aria-busy={busy || undefined}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm">{co.label}</span>
          <StatusPill status={co.status} />
        </div>
        <p className="truncate text-sm text-muted-foreground">
          {co.title} · {co.items.length} line{co.items.length === 1 ? "" : "s"}
          {link ? ` · ${link}` : ""} · {fmtDate(co.created_at)}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("font-medium tabular-nums", co.delta_minor < 0 && "text-red-700 dark:text-red-300")}>
          {co.delta_minor >= 0 ? "+" : ""}
          {fmtMoney(co.delta_minor, co.currency)}
        </span>
        {co.status === "draft" && (
          <Button size="sm" variant="outline" touch disabled={busy} onClick={() => onStatus(co, "sent")}>
            Mark sent
          </Button>
        )}
        {open && (
          <Button size="sm" touch disabled={busy || co.items.length === 0} onClick={() => onStatus(co, "accepted")} title="Bills the lines to the linked draft invoice or a new one">
            Accept
          </Button>
        )}
        {open && (
          <Button size="sm" variant="ghost" touch disabled={busy} onClick={() => onStatus(co, "rejected")}>
            Reject
          </Button>
        )}
        {co.status === "rejected" && (
          <Button size="sm" variant="ghost" touch disabled={busy} onClick={() => onStatus(co, "draft")}>
            Reopen
          </Button>
        )}
        {co.status !== "accepted" && (
          <Button size="icon-sm" variant="ghost" touch disabled={busy} onClick={() => onEdit(co)} aria-label={`Edit ${co.label}`}>
            <Pencil className="h-3.5 w-3.5" aria-hidden />
          </Button>
        )}
        {co.status !== "accepted" && (
          <Button size="icon-sm" variant="ghost" touch disabled={busy} onClick={() => onDelete(co)} aria-label={`Delete ${co.label}`}>
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          </Button>
        )}
        {busy && spinner}
      </div>
    </li>
  );
});

/* ── Dialogs ─────────────────────────────────────────────────────────────── */

function JobPicker({ kind, id, docs, onChange }: { kind: string; id: string; docs: Docs; onChange: (kind: string, id: string) => void }) {
  const list = kind === "invoice" ? docs.invoices : kind === "quote" ? docs.quotes : null;
  return (
    <>
      <Field label="Job type">
        <Select value={kind} onChange={(e) => onChange(e.target.value, "")}>
          {REF_KINDS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
      </Field>
      {kind && (
        <Field label={list ? (kind === "invoice" ? "Invoice" : "Quote") : "Job ID"}>
          {list ? (
            <Select value={id} onChange={(e) => onChange(kind, e.target.value)}>
              <option value="">Pick one…</option>
              {list.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.number}
                  {d.contact_name ? ` · ${d.contact_name}` : ""} ({d.status})
                </option>
              ))}
            </Select>
          ) : (
            <Input maxLength={100} value={id} onChange={(e) => onChange(kind, e.target.value)} placeholder="Paste the ID" spellCheck={false} autoComplete="off" />
          )}
        </Field>
      )}
    </>
  );
}

function FormError({ error, onDismiss }: { error: string | null; onDismiss: () => void }) {
  if (!error) return null;
  return (
    <Banner tone="error" onDismiss={onDismiss} className="mb-0">
      {error}
    </Banner>
  );
}

function ExpenseDialog({ expense, docs, onClose, onSaved }: { expense: Expense | null; docs: Docs; onClose: () => void; onSaved: (m: string) => void }) {
  const [f, setF] = useState({
    category: expense?.category ?? "general", vendor: expense?.vendor ?? "", description: expense?.description ?? "", amount: fromMinor(expense?.amount_minor ?? 0),
    tax: fromMinor(expense?.tax_minor ?? 0), currency: expense?.currency ?? "USD", date: expense ? expense.spent_at.slice(0, 10) : todayLocalISODate(),
    receipt: expense?.receipt_url ?? "", refKind: expense?.ref_kind ?? "", refId: expense?.ref_id ?? "", billable: expense?.billable ?? false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));
  const locked = Boolean(expense?.invoice_id);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        category: f.category, vendor: f.vendor.trim() || null, description: f.description.trim() || null,
        spent_at: new Date(f.date + "T12:00:00").toISOString(), receipt_url: f.receipt.trim() || null,
        ref_kind: f.refKind || null, ref_id: f.refKind ? f.refId.trim() || null : null, billable: f.billable,
      };
      if (!locked) Object.assign(body, { amount_minor: toMinor(f.amount), tax_minor: toMinor(f.tax), currency: f.currency.toUpperCase() });
      await api(expense ? `/api/expenses/${expense.id}` : "/api/expenses", { method: expense ? "PATCH" : "POST", body: JSON.stringify(body) });
      onSaved(expense ? "Expense updated." : "Expense logged.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the expense.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title={expense ? "Edit expense" : "Log expense"} onClose={onClose} size="lg">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Amount (before tax)" required>
            <Input data-autofocus required type="number" inputMode="decimal" min={0} step="0.01" value={f.amount} disabled={locked} onChange={(e) => set("amount", e.target.value)} />
          </Field>
          <Field label="Tax">
            <Input type="number" inputMode="decimal" min={0} step="0.01" value={f.tax} disabled={locked} onChange={(e) => set("tax", e.target.value)} />
          </Field>
          <Field label="Currency">
            <Input maxLength={3} value={f.currency} disabled={locked} onChange={(e) => set("currency", e.target.value.toUpperCase())} spellCheck={false} autoComplete="off" />
          </Field>
          <Field label="Category">
            <Select value={f.category} onChange={(e) => set("category", e.target.value)} className="capitalize">
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Vendor">
            <Input maxLength={200} value={f.vendor} onChange={(e) => set("vendor", e.target.value)} />
          </Field>
          <Field label="Date" required>
            <Input type="date" required value={f.date} onChange={(e) => set("date", e.target.value)} />
          </Field>
          <Field label="Description" className="sm:col-span-3">
            <Input maxLength={2000} value={f.description} onChange={(e) => set("description", e.target.value)} placeholder="What was it for?" />
          </Field>
          <Field label="Receipt URL" className="sm:col-span-3">
            <Input type="url" inputMode="url" maxLength={2000} value={f.receipt} onChange={(e) => set("receipt", e.target.value)} placeholder="https://…" spellCheck={false} autoComplete="off" />
          </Field>
          <JobPicker kind={f.refKind} id={f.refId} docs={docs} onChange={(k, id) => setF((p) => ({ ...p, refKind: k, refId: id }))} />
        </div>
        <Checkbox checked={f.billable} onChange={(e) => set("billable", e.target.checked)} label="Billable to the client" />
        {locked && <p className="text-xs text-muted-foreground">This expense is on an invoice, so its amounts are locked.</p>}
        <FormError error={error} onDismiss={() => setError(null)} />
        <DialogFooter>
          <Button type="button" variant="outline" touch onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" touch disabled={saving}>
            {saving && spinner} {expense ? "Save changes" : "Log expense"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function TimeDialog({ entry, docs, hasRunning, onClose, onSaved }: { entry: TimeEntry | null; docs: Docs; hasRunning: boolean; onClose: () => void; onSaved: (m: string) => void }) {
  const [mode, setMode] = useState<"timer" | "manual">(entry ? "manual" : hasRunning ? "manual" : "timer");
  const [f, setF] = useState({
    description: entry?.description ?? "", date: entry ? entry.started_at.slice(0, 10) : todayLocalISODate(),
    start: entry ? new Date(entry.started_at).toTimeString().slice(0, 5) : "09:00", minutes: String(entry?.minutes ?? 60),
    rate: fromMinor(entry?.rate_minor ?? 0), currency: entry?.currency ?? "USD", refKind: entry?.ref_kind ?? "", refId: entry?.ref_id ?? "", billable: entry?.billable ?? true,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));
  const locked = Boolean(entry?.invoice_id);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        description: f.description.trim() || null, rate_minor: toMinor(f.rate), currency: f.currency.toUpperCase(),
        ref_kind: f.refKind || null, ref_id: f.refKind ? f.refId.trim() || null : null, billable: f.billable,
      };
      if (locked) {
        delete body.rate_minor;
        delete body.currency;
      }
      if (mode === "manual" && !locked && !entry?.running) {
        const m = Math.trunc(Number(f.minutes));
        if (!m || m <= 0) throw new Error("Enter the minutes worked.");
        body.started_at = new Date(`${f.date}T${f.start}:00`).toISOString();
        body.minutes = m;
      }
      await api(entry ? `/api/time/${entry.id}` : "/api/time", { method: entry ? "PATCH" : "POST", body: JSON.stringify(body) });
      onSaved(entry ? "Time entry updated." : mode === "timer" ? "Timer started." : "Time logged.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the time entry.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title={entry ? "Edit time entry" : mode === "timer" ? "Start timer" : "Log time"} onClose={onClose} size="lg">
      <form onSubmit={submit} className="space-y-4">
        {!entry && (
          <div role="radiogroup" aria-label="Entry mode" className="flex flex-wrap gap-2">
            {(["timer", "manual"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                onClick={() => setMode(m)}
                disabled={m === "timer" && hasRunning}
                className={cn(
                  "inline-flex min-h-11 items-center rounded-md border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 sm:min-h-9",
                  mode === m ? "border-primary bg-accent text-accent-foreground" : "border-border hover:bg-secondary/60"
                )}
              >
                {m === "timer" ? "Start a timer now" : "Enter hours manually"}
              </button>
            ))}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="What are you working on?" className="sm:col-span-3">
            <Input data-autofocus maxLength={2000} value={f.description} onChange={(e) => set("description", e.target.value)} placeholder="Site visit, design revisions…" />
          </Field>
          {mode === "manual" && !entry?.running && (
            <>
              <Field label="Date" required>
                <Input type="date" required value={f.date} disabled={locked} onChange={(e) => set("date", e.target.value)} />
              </Field>
              <Field label="Start time" required>
                <Input type="time" required value={f.start} disabled={locked} onChange={(e) => set("start", e.target.value)} />
              </Field>
              <Field label="Minutes" required>
                <Input type="number" inputMode="numeric" min={1} step={1} required value={f.minutes} disabled={locked} onChange={(e) => set("minutes", e.target.value)} />
              </Field>
            </>
          )}
          <Field label="Hourly rate" hint="Used for job costing and billing">
            <Input type="number" inputMode="decimal" min={0} step="0.01" value={f.rate} disabled={locked} onChange={(e) => set("rate", e.target.value)} />
          </Field>
          <Field label="Currency">
            <Input maxLength={3} value={f.currency} disabled={locked} onChange={(e) => set("currency", e.target.value.toUpperCase())} spellCheck={false} autoComplete="off" />
          </Field>
          <div className="hidden sm:block" aria-hidden />
          <JobPicker kind={f.refKind} id={f.refId} docs={docs} onChange={(k, id) => setF((p) => ({ ...p, refKind: k, refId: id }))} />
        </div>
        <Checkbox checked={f.billable} onChange={(e) => set("billable", e.target.checked)} label="Billable to the client" />
        <FormError error={error} onDismiss={() => setError(null)} />
        <DialogFooter>
          <Button type="button" variant="outline" touch onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" touch disabled={saving}>
            {saving ? spinner : mode === "timer" && !entry ? <Play className="h-4 w-4" aria-hidden /> : null} {entry ? "Save changes" : mode === "timer" ? "Start timer" : "Log time"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

const BLANK: LineItem = { description: "", qty: 1, unit_minor: 0, tax_rate_bp: 0 };

function ChangeOrderDialog({ co, docs, onClose, onSaved }: { co: ChangeOrder | null; docs: Docs; onClose: () => void; onSaved: (m: string) => void }) {
  const [title, setTitle] = useState(co?.title ?? "");
  const [description, setDescription] = useState(co?.description ?? "");
  const [quoteId, setQuoteId] = useState(co?.quote_id ?? "");
  const [invoiceId, setInvoiceId] = useState(co?.invoice_id ?? "");
  const [currency, setCurrency] = useState(co?.currency ?? "USD");
  const [items, setItems] = useState<LineItem[]>(co?.items.length ? co.items : [{ ...BLANK }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const totals = useMemo(() => computeTotalsClient(items), [items]);
  const setItem = (i: number, patch: Partial<LineItem>) => setItems((p) => p.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const clean = items.filter((it) => it.description.trim());
      const body = { title: title.trim(), description: description.trim() || null, quote_id: quoteId || null, invoice_id: invoiceId || null, currency: currency.toUpperCase(), items: clean };
      const r = await api<{ change_order: ChangeOrder }>(co ? `/api/change-orders/${co.id}` : "/api/change-orders", { method: co ? "PATCH" : "POST", body: JSON.stringify(body) });
      onSaved(`${co ? "Updated" : "Created"} ${r.change_order.label}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the change order.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title={co ? `Edit ${co.label}` : "New change order"} onClose={onClose} size="lg">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Title" required className="sm:col-span-2">
            <Input data-autofocus required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Extra bedroom repaint" />
          </Field>
          <Field label="Currency">
            <Input maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} spellCheck={false} autoComplete="off" />
          </Field>
          <Field label="Quote" hint="Where the original scope lives">
            <Select value={quoteId} onChange={(e) => setQuoteId(e.target.value)}>
              <option value="">None</option>
              {docs.quotes.map((q) => (
                <option key={q.id} value={q.id}>
                  {q.number}
                  {q.contact_name ? ` · ${q.contact_name}` : ""} ({q.status})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Invoice" hint="Draft invoices get the lines appended on accept" className="sm:col-span-2">
            <Select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
              <option value="">Create a new invoice on accept</option>
              {docs.invoices.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.number}
                  {i.contact_name ? ` · ${i.contact_name}` : ""} ({i.status})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Why the change?" className="sm:col-span-3">
            <Textarea rows={2} maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </div>

        <fieldset>
          <legend className="mb-1 text-xs font-medium">Lines</legend>
          <div className="mb-1 hidden grid-cols-12 gap-2 text-xs uppercase tracking-wide text-muted-foreground sm:grid" aria-hidden>
            <span className="col-span-6">Description</span>
            <span className="col-span-2">Qty</span>
            <span className="col-span-2">Unit price</span>
            <span className="col-span-2">Tax %</span>
          </div>
          {items.map((it, i) => (
            <div key={i} className="mb-2 grid grid-cols-12 gap-2">
              <label className="col-span-12 sm:col-span-6">
                <span className="sr-only">Line {i + 1} description</span>
                <Input placeholder="Line description" value={it.description} onChange={(e) => setItem(i, { description: e.target.value })} />
              </label>
              <label className="col-span-4 sm:col-span-2">
                <span className="sr-only">Line {i + 1} quantity</span>
                <Input type="number" inputMode="decimal" min={0} step="0.01" value={it.qty} onChange={(e) => setItem(i, { qty: Number(e.target.value) || 0 })} />
              </label>
              <label className="col-span-4 sm:col-span-2">
                <span className="sr-only">Line {i + 1} unit price</span>
                <Input type="number" inputMode="decimal" step="0.01" value={fromMinor(it.unit_minor)} onChange={(e) => setItem(i, { unit_minor: toMinor(e.target.value) })} />
              </label>
              <div className="col-span-4 flex gap-1 sm:col-span-2">
                <label className="min-w-0 flex-1">
                  <span className="sr-only">Line {i + 1} tax percent</span>
                  <Input type="number" inputMode="decimal" min={0} max={100} step="0.01" value={(it.tax_rate_bp / 100).toString()} onChange={(e) => setItem(i, { tax_rate_bp: Math.round((Number(e.target.value) || 0) * 100) })} />
                </label>
                <Button type="button" size="icon" variant="ghost" touch onClick={() => setItems((p) => p.filter((_, idx) => idx !== i))} aria-label={`Remove line ${i + 1}`} disabled={items.length === 1}>
                  <X className="h-4 w-4" aria-hidden />
                </Button>
              </div>
            </div>
          ))}
          <Button type="button" size="sm" variant="ghost" touch onClick={() => setItems((p) => [...p, { ...BLANK }])}>
            <Plus className="h-3.5 w-3.5" aria-hidden /> Add line
          </Button>
          <p className="mt-1 text-xs text-muted-foreground">Use a negative unit price for a credit.</p>
        </fieldset>

        <FormError error={error} onDismiss={() => setError(null)} />
        <DialogFooter
          start={
            <>
              Subtotal {fmtMoney(totals.subtotal_minor, currency)} · Tax {fmtMoney(totals.tax_minor, currency)} · <span className="font-semibold text-foreground">Change {fmtMoney(totals.total_minor, currency)}</span>
            </>
          }
        >
          <Button type="button" variant="outline" touch onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" touch disabled={saving || !title.trim()}>
            {saving && spinner} {co ? "Save changes" : "Create change order"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
