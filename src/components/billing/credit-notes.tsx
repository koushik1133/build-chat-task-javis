"use client";

import { useEffect, useMemo, useState } from "react";
import { FileDown, FileMinus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea, Checkbox } from "@/components/ui/input";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Banner, Empty } from "@/components/ui/feedback";
import { fmtDate, fmtMoney } from "@/lib/money/format";
import { LineItemsEditor, StatusPill, TotalsSummary, useDocTotals, useTaxRates, type LineItem } from "./shared";

export interface CreditNote {
  id: string; number: string; status: string; currency: string; total_minor: number; reason: string | null;
  invoice_id: string | null; invoice_number: string | null; contact_name: string | null; issued_at: string | null; created_at: string;
}
export interface InvoiceLite { id: string; number: string; currency: string; items: LineItem[]; total_minor: number; paid_minor: number; contact_name: string | null }
interface Payment { id: string; provider: string; amount_minor: number; currency: string; status: string; created_at: string; refunded_minor: number }

const spinner = <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.detail?.formErrors?.[0] ?? (typeof data?.detail === "string" ? data.detail : null) ?? data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

export function CreditNoteList({ notes, busyId, onIssue, onDelete }: { notes: CreditNote[]; busyId: string | null; onIssue: (n: CreditNote) => void; onDelete: (n: CreditNote) => void }) {
  if (notes.length === 0) {
    return <Empty icon={<FileMinus className="h-5 w-5" />} title="No credit notes" text="Use “Credit note” on an invoice to credit part or all of it." />;
  }
  return (
    <ul className="divide-y divide-border rounded-xl border border-border bg-card" aria-label="Credit notes">
      {notes.map((n) => {
        const busy = busyId === n.id;
        return (
          <li key={n.id} className="flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center lg:justify-between" aria-busy={busy || undefined}>
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm">{n.number}</span>
                  <StatusPill status={n.status} />
                </div>
                <p className="mt-0.5 truncate text-sm text-muted-foreground">
                  {n.contact_name ?? "No contact"}{n.invoice_number ? ` · against ${n.invoice_number}` : ""} · {fmtDate(n.issued_at ?? n.created_at)}{n.reason ? ` · ${n.reason}` : ""}
                </p>
              </div>
              <span className="shrink-0 font-medium tabular-nums lg:hidden">−{fmtMoney(n.total_minor, n.currency)}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="mr-1 hidden font-medium tabular-nums lg:inline">−{fmtMoney(n.total_minor, n.currency)}</span>
              {n.status === "draft" && (
                <Button size="sm" variant="outline" touch disabled={busy} onClick={() => onIssue(n)}>Issue</Button>
              )}
              <Button asChild size="sm" variant="outline" touch>
                <a href={`/api/credit-notes/${n.id}/pdf`} target="_blank" rel="noopener" aria-label={`Download PDF for ${n.number}`}>
                  <FileDown className="h-3.5 w-3.5" aria-hidden /> PDF
                </a>
              </Button>
              {n.status === "draft" && (
                <Button size="sm" variant="ghost" touch disabled={busy} onClick={() => onDelete(n)} aria-label={`Delete draft ${n.number}`}>Delete</Button>
              )}
              {busy && <span role="status" className="inline-flex items-center">{spinner}<span className="sr-only">Working…</span></span>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Credit an invoice: full amount by default, or edit the lines. */
export function CreditNoteDialog({ invoice, onClose, onCreated }: { invoice: InvoiceLite; onClose: () => void; onCreated: (msg: string) => void }) {
  const { rates, inclusive, rounding } = useTaxRates();
  const [full, setFull] = useState(true);
  const [items, setItems] = useState<LineItem[]>(invoice.items.length ? invoice.items : [{ description: "", qty: 1, unit_minor: 0, tax_rate_bp: 0 }]);
  const [reason, setReason] = useState("");
  const [issueNow, setIssueNow] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opts = useMemo(() => ({ inclusive, rounding }), [inclusive, rounding]);
  const totals = useDocTotals(full ? invoice.items : items, rates, opts);
  const [touched, setTouched] = useState(false);
  // Inline validation for a partial credit: at least one described line, a positive total, never more than was invoiced.
  const itemsError = full
    ? null
    : items.filter((it) => it.description.trim()).length === 0
      ? "Add at least one line item."
      : totals.total_minor <= 0
        ? "The credit must be more than " + fmtMoney(0, invoice.currency) + "."
        : totals.total_minor > invoice.total_minor
          ? `The credit cannot exceed the invoiced ${fmtMoney(invoice.total_minor, invoice.currency)}.`
          : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (itemsError) return;
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { invoice_id: invoice.id, reason: reason || null, issue: issueNow };
      if (!full) body.items = items.filter((it) => it.description.trim());
      const r = await api<{ credit_note: { number: string; status: string } }>("/api/credit-notes", { method: "POST", body: JSON.stringify(body) });
      onCreated(`Credit note ${r.credit_note.number} ${r.credit_note.status === "draft" ? "drafted" : "issued"} against ${invoice.number}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create credit note.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title={`Credit note for ${invoice.number}`} onClose={onClose} size="lg">
      <form onSubmit={submit} className="space-y-4">
        {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}
        <p className="text-sm text-muted-foreground">
          {invoice.contact_name ?? "No contact"} · invoiced {fmtMoney(invoice.total_minor, invoice.currency)}{invoice.paid_minor > 0 ? ` · paid ${fmtMoney(invoice.paid_minor, invoice.currency)}` : ""}
        </p>
        <Checkbox label="Credit the full invoice" checked={full} onChange={(e) => setFull(e.target.checked)} />
        {!full && (
          <div>
            <LineItemsEditor items={items} onChange={setItems} rates={rates} currency={invoice.currency} />
            {touched && itemsError && (
              <p role="alert" className="mt-2 text-xs text-destructive">{itemsError}</p>
            )}
          </div>
        )}
        <Field label="Reason" hint="Printed on the credit note">
          <Textarea rows={2} value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Checkbox label="Issue immediately (otherwise saved as a draft)" checked={issueNow} onChange={(e) => setIssueNow(e.target.checked)} />
        <DialogFooter start={<TotalsSummary totals={totals} currency={invoice.currency} inclusive={inclusive} />}>
          <Button type="button" variant="ghost" touch onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="submit" touch disabled={saving || (touched && Boolean(itemsError))}>{saving && spinner} {issueNow ? "Issue credit note" : "Save draft"}</Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** Refund a succeeded payment through its provider. */
export function RefundDialog({ invoice, onClose, onDone }: { invoice: InvoiceLite; onClose: () => void; onDone: (msg: string) => void }) {
  const [payments, setPayments] = useState<Payment[] | null>(null);
  const [notes, setNotes] = useState<CreditNote[]>([]);
  const [paymentId, setPaymentId] = useState("");
  const [amount, setAmount] = useState("");
  const [creditNoteId, setCreditNoteId] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    api<{ payments: Payment[] }>(`/api/invoices/${invoice.id}/payments`, { signal: ctrl.signal })
      .then((d) => {
        const ok = d.payments.filter((p) => p.status === "succeeded" && p.amount_minor - p.refunded_minor > 0);
        setPayments(ok);
        if (ok[0]) {
          setPaymentId(ok[0].id);
          setAmount(((ok[0].amount_minor - ok[0].refunded_minor) / 100).toFixed(2));
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load payments."));
    api<{ credit_notes: CreditNote[] }>(`/api/credit-notes?invoice_id=${encodeURIComponent(invoice.id)}`, { signal: ctrl.signal })
      .then((d) => setNotes(d.credit_notes.filter((n) => n.status === "issued" || n.status === "applied")))
      .catch(() => setNotes([]));
    return () => ctrl.abort();
  }, [invoice.id]);

  const selected = payments?.find((p) => p.id === paymentId) ?? null;
  const refundable = selected ? selected.amount_minor - selected.refunded_minor : 0;
  const minor = Math.round((Number(amount) || 0) * 100);
  const amountError = !selected
    ? null
    : amount.trim() === "" || !Number.isFinite(Number(amount))
      ? "Enter an amount."
      : minor <= 0
        ? `Enter more than ${fmtMoney(0, selected.currency)}.`
        : minor > refundable
          ? `Enter at most ${fmtMoney(refundable, selected.currency)} (what is left on this payment).`
          : null;
  const [amountTouched, setAmountTouched] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setAmountTouched(true);
    if (amountError) return;
    setSaving(true);
    setError(null);
    try {
      if (!selected) throw new Error("Pick a payment to refund.");
      const r = await api<{ refund_ref: string; invoice_status: string | null }>(`/api/invoices/${invoice.id}/refund`, {
        method: "POST",
        body: JSON.stringify({ paymentId: selected.id, amount_minor: minor, credit_note_id: creditNoteId || null, reason: reason || null }),
      });
      onDone(`Refunded ${fmtMoney(minor, selected.currency)} on ${invoice.number} (ref ${r.refund_ref}).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refund failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title={`Refund ${invoice.number}`} onClose={onClose} size="md">
      <form onSubmit={submit} className="space-y-4">
        {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}
        {payments === null ? (
          <p role="status" className="text-sm text-muted-foreground">Loading payments…</p>
        ) : payments.length === 0 ? (
          <Banner tone="info">No refundable payments on this invoice.</Banner>
        ) : (
          <>
            <Field label="Payment">
              <Select value={paymentId} onChange={(e) => { setPaymentId(e.target.value); const p = payments.find((x) => x.id === e.target.value); if (p) setAmount(((p.amount_minor - p.refunded_minor) / 100).toFixed(2)); }}>
                {payments.map((p) => (
                  <option key={p.id} value={p.id}>{fmtMoney(p.amount_minor, p.currency)} via {p.provider} · {fmtDate(p.created_at)}{p.refunded_minor > 0 ? ` (${fmtMoney(p.refunded_minor, p.currency)} refunded)` : ""}</option>
                ))}
              </Select>
            </Field>
            <Field
              label={`Amount${selected ? ` (${selected.currency})` : ""}`}
              hint={selected ? `Up to ${fmtMoney(refundable, selected.currency)}${minor > 0 && !amountError ? ` · refunding ${fmtMoney(minor, selected.currency)}` : ""}` : undefined}
              error={amountTouched ? amountError : null}
              required
            >
              <Input type="number" inputMode="decimal" min={0.01} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} onBlur={() => setAmountTouched(true)} />
            </Field>
            {notes.length > 0 && (
              <Field label="Link to credit note" hint="Marks the note as refunded">
                <Select value={creditNoteId} onChange={(e) => setCreditNoteId(e.target.value)}>
                  <option value="">None</option>
                  {notes.map((n) => <option key={n.id} value={n.id}>{n.number} · {fmtMoney(n.total_minor, n.currency)}</option>)}
                </Select>
              </Field>
            )}
            <Field label="Reason" hint="Optional">
              <Input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" touch onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="submit" touch disabled={saving || !selected || (amountTouched && Boolean(amountError))}>
            {saving && spinner} {selected && !amountError && minor > 0 ? `Refund ${fmtMoney(minor, selected.currency)}` : "Refund"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
