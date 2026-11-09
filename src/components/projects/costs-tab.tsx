"use client";

import { useCallback, useEffect, useState } from "react";
import { Clock, Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Empty, ErrorState, SkeletonList } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { Checkbox, Input, Select } from "@/components/ui/input";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { fmtMoney } from "@/lib/money/format";
import type { ExpenseDTO } from "@/lib/finance/expenses";
import type { TimeEntryDTO } from "@/lib/finance/time";
import type { ProjectBudget, ProjectDTO } from "@/lib/projects/pure";
import type { Notice } from "./types";
import { hours, isoToLocal, jsonFetch, localToIso } from "./shared";

const EXPENSE_CATEGORIES = ["general", "materials", "subcontractor", "travel", "fuel", "equipment", "software", "marketing", "meals", "fees", "other"] as const;

/**
 * Time entries and expenses for the project (ref_kind='project'), with
 * "Log time" and "Add expense" dialogs that post to the finance routes.
 */
export function CostsTab({ project, budget, reloadProject, notify }: { project: ProjectDTO; budget: ProjectBudget; reloadProject: () => Promise<void>; notify: (tone: Notice["tone"], text: string) => void }) {
  const [time, setTime] = useState<TimeEntryDTO[] | null>(null);
  const [expenses, setExpenses] = useState<ExpenseDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logTime, setLogTime] = useState(false);
  const [addExpense, setAddExpense] = useState(false);
  const ref = `project:${project.id}`;
  const readOnly = Boolean(project.archived_at);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [t, e] = await Promise.all([
        jsonFetch<{ entries: TimeEntryDTO[] }>(`/api/time?ref=${encodeURIComponent(ref)}`, { fallback: "Could not load time entries" }),
        jsonFetch<{ expenses: ExpenseDTO[] }>(`/api/expenses?ref=${encodeURIComponent(ref)}`, { fallback: "Could not load expenses" }),
      ]);
      setTime(t.entries);
      setExpenses(e.expenses);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load costs");
    }
  }, [ref]);
  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async () => {
    await Promise.all([load(), reloadProject()]);
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Tile label="Time" value={fmtMoney(budget.time_minor, budget.currency)} hint={hours(budget.time_minutes)} />
        <Tile label="Expenses" value={fmtMoney(budget.expense_minor, budget.currency)} />
        <Tile label="Actual vs budget" value={fmtMoney(budget.actual_minor, budget.currency)} hint={budget.burn_pct === null ? "No budget" : `${budget.burn_pct}% of ${fmtMoney(budget.budget_minor, budget.currency)}`} danger={budget.over_budget} />
      </div>
      {error && <ErrorState message={error} onRetry={load} />}

      <section aria-labelledby="time-h" className="rounded-xl border border-border bg-card p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 id="time-h" className="text-base font-semibold">
            Time entries
          </h2>
          {!readOnly && (
            <Button size="sm" variant="outline" onClick={() => setLogTime(true)}>
              <Clock className="h-4 w-4" aria-hidden /> Log time
            </Button>
          )}
        </div>
        {time === null ? (
          <SkeletonList count={3} itemClassName="h-10" label="Loading time…" />
        ) : time.length === 0 ? (
          <Empty title="No time logged" text="Log hours against this project to see them in budget burn." />
        ) : (
          <TableScroller label="Time entries">
            <table className="w-full min-w-[560px] text-sm">
              <thead className={THEAD}>
                <tr>
                  <th className={TH}>When</th>
                  <th className={TH}>Description</th>
                  <th className={`${TH} text-right`}>Minutes</th>
                  <th className={`${TH} text-right`}>Value</th>
                  <th className={TH}>Billable</th>
                </tr>
              </thead>
              <tbody>
                {time.map((e) => (
                  <tr key={e.id} className="border-t border-border">
                    <td className="px-3 py-2 tabular-nums">{new Date(e.started_at).toLocaleString()}</td>
                    <td className="px-3 py-2">{e.description ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{e.running ? "running" : e.minutes}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(e.value_minor, e.currency)}</td>
                    <td className="px-3 py-2">{e.billable ? "Yes" : "No"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
        )}
      </section>

      <section aria-labelledby="exp-h" className="rounded-xl border border-border bg-card p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 id="exp-h" className="text-base font-semibold">
            Expenses
          </h2>
          {!readOnly && (
            <Button size="sm" variant="outline" onClick={() => setAddExpense(true)}>
              <Receipt className="h-4 w-4" aria-hidden /> Add expense
            </Button>
          )}
        </div>
        {expenses === null ? (
          <SkeletonList count={3} itemClassName="h-10" label="Loading expenses…" />
        ) : expenses.length === 0 ? (
          <Empty title="No expenses" text="Materials, subcontractors and travel logged here count against the budget." />
        ) : (
          <TableScroller label="Expenses">
            <table className="w-full min-w-[560px] text-sm">
              <thead className={THEAD}>
                <tr>
                  <th className={TH}>Date</th>
                  <th className={TH}>Category</th>
                  <th className={TH}>Vendor / description</th>
                  <th className={`${TH} text-right`}>Total</th>
                  <th className={TH}>Billable</th>
                </tr>
              </thead>
              <tbody>
                {expenses.map((x) => (
                  <tr key={x.id} className="border-t border-border">
                    <td className="px-3 py-2 tabular-nums">{new Date(x.spent_at).toLocaleDateString()}</td>
                    <td className="px-3 py-2 capitalize">{x.category}</td>
                    <td className="px-3 py-2">{[x.vendor, x.description].filter(Boolean).join(" — ") || "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(x.total_minor, x.currency)}</td>
                    <td className="px-3 py-2">{x.billable ? "Yes" : "No"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
        )}
      </section>

      {logTime && (
        <LogTimeDialog
          project={project}
          onClose={() => setLogTime(false)}
          onSaved={() => {
            setLogTime(false);
            notify("success", "Time logged.");
            void refresh();
          }}
        />
      )}
      {addExpense && (
        <ExpenseDialog
          project={project}
          onClose={() => setAddExpense(false)}
          onSaved={() => {
            setAddExpense(false);
            notify("success", "Expense added.");
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function Tile({ label, value, hint, danger }: { label: string; value: string; hint?: string; danger?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-xl font-semibold tabular-nums ${danger ? "text-red-600 dark:text-red-400" : ""}`}>{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function LogTimeDialog({ project, onClose, onSaved }: { project: ProjectDTO; onClose: () => void; onSaved: () => void }) {
  const [started, setStarted] = useState(isoToLocal(new Date(Date.now() - 3_600_000).toISOString()));
  const [minutes, setMinutes] = useState("60");
  const [description, setDescription] = useState("");
  const [rate, setRate] = useState(project.hourly_rate_minor ? String(project.hourly_rate_minor / 100) : "");
  const [billable, setBillable] = useState(project.billing_mode === "hourly");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await jsonFetch("/api/time", {
        method: "POST",
        body: JSON.stringify({
          ref_kind: "project",
          ref_id: project.id,
          description: description.trim() || null,
          started_at: localToIso(started) ?? new Date().toISOString(),
          minutes: Math.max(1, Math.round(Number(minutes) || 0)),
          rate_minor: Math.round((Number(rate) || 0) * 100),
          currency: project.currency,
          billable,
        }),
        fallback: "Could not log time",
      });
      onSaved();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not log time");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="Log time" description={`Against ${project.name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {err && <p role="alert" className="text-sm text-red-600">{err}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Started" required>
            <Input type="datetime-local" value={started} onChange={(e) => setStarted(e.target.value)} required />
          </Field>
          <Field label="Minutes" required>
            <Input type="number" min={1} step={5} inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} required />
          </Field>
        </div>
        <Field label="What did you do?">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
        </Field>
        <Field label={`Hourly rate (${project.currency})`} hint="Leave blank to use the project rate in budget maths.">
          <Input type="number" min={0} step="0.01" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
        </Field>
        <Checkbox label="Billable to the client" checked={billable} onChange={(e) => setBillable(e.target.checked)} />
        <DialogFooter>
          <Button type="button" variant="outline" touch onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" touch disabled={busy}>
            {busy ? "Saving…" : "Log time"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function ExpenseDialog({ project, onClose, onSaved }: { project: ProjectDTO; onClose: () => void; onSaved: () => void }) {
  const [category, setCategory] = useState<(typeof EXPENSE_CATEGORIES)[number]>("materials");
  const [vendor, setVendor] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [tax, setTax] = useState("");
  const [spent, setSpent] = useState(new Date().toISOString().slice(0, 10));
  const [billable, setBillable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await jsonFetch("/api/expenses", {
        method: "POST",
        body: JSON.stringify({
          category,
          vendor: vendor.trim() || null,
          description: description.trim() || null,
          amount_minor: Math.round((Number(amount) || 0) * 100),
          tax_minor: Math.round((Number(tax) || 0) * 100),
          currency: project.currency,
          spent_at: new Date(`${spent}T12:00:00`).toISOString(),
          ref_kind: "project",
          ref_id: project.id,
          billable,
        }),
        fallback: "Could not add expense",
      });
      onSaved();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not add expense");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="Add expense" description={`Against ${project.name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {err && <p role="alert" className="text-sm text-red-600">{err}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Category">
            <Select value={category} onChange={(e) => setCategory(e.target.value as typeof category)}>
              {EXPENSE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Date" required>
            <Input type="date" value={spent} onChange={(e) => setSpent(e.target.value)} required />
          </Field>
          <Field label={`Amount (${project.currency})`} required>
            <Input type="number" min={0} step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </Field>
          <Field label="Tax">
            <Input type="number" min={0} step="0.01" inputMode="decimal" value={tax} onChange={(e) => setTax(e.target.value)} />
          </Field>
        </div>
        <Field label="Vendor">
          <Input value={vendor} onChange={(e) => setVendor(e.target.value)} maxLength={200} />
        </Field>
        <Field label="Description">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
        </Field>
        <Checkbox label="Billable to the client" checked={billable} onChange={(e) => setBillable(e.target.checked)} />
        <DialogFooter>
          <Button type="button" variant="outline" touch onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" touch disabled={busy}>
            {busy ? "Saving…" : "Add expense"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
