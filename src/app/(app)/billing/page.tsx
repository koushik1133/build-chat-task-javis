"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Plus, RefreshCw, Send, FileCheck2, Link2, Ban, Trash2, X, Copy, Receipt, FileDown, XCircle, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { PageContainer } from "@/components/page-container";
import { cn } from "@/lib/utils";
import { fmtDate, fmtMoney } from "@/lib/money/format";
import { StatusPill, computeTotalsClient, type LineItem } from "@/components/billing/shared";

interface Contact { id: string; full_name: string; email: string | null; company: string | null }
interface Quote {
  id: string; number: string; status: string; currency: string; total_minor: number; contact_name: string | null;
  contact_email: string | null; items: LineItem[]; valid_until: string | null; created_at: string; sent_at: string | null;
}
interface Invoice {
  id: string; number: string; status: string; currency: string; total_minor: number; paid_minor: number; contact_name: string | null;
  contact_email: string | null; items: LineItem[]; due_at: string | null; created_at: string; quote_id: string | null;
}
interface ProviderInfo { id: string; configured: boolean; active: boolean }

type Tab = "quotes" | "invoices";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.detail?.formErrors?.[0] ?? data?.detail ?? data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

export default function BillingPage() {
  const [tab, setTab] = useState<Tab>("quotes");
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | "quote" | "invoice">(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [q, i] = await Promise.all([api<{ quotes: Quote[] }>("/api/quotes"), api<{ invoices: Invoice[]; providers: ProviderInfo[] }>("/api/invoices")]);
      setQuotes(q.quotes); setInvoices(i.invoices); setProviders(i.providers);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load billing."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function act(id: string, fn: () => Promise<string | void>) {
    setBusyId(id); setError(null); setNotice(null);
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Action failed."); }
    finally { setBusyId(null); }
  }

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setNotice("Link copied to clipboard."); }
    catch { setNotice(text); }
  }

  const active = providers.find((p) => p.active);

  return (
    <PageContainer
      wide
      title="Billing"
      description="Quotes your clients can accept online, invoices they can pay, and the money that came in."
      tooltip="Send a quote, get it accepted with email verification, convert it to an invoice and collect payment through a share link."
    >
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 rounded-lg border border-border p-1">
          {(["quotes", "invoices"] as Tab[]).map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)}
              className={cn("rounded-md px-3 py-1.5 text-sm capitalize transition-colors", tab === t ? "bg-primary text-primary-foreground" : "hover:bg-secondary/60")}>
              {t}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {active && (
            <span className="text-xs text-muted-foreground">
              Payments: <span className="font-medium capitalize">{active.id}</span>{!active.configured && " (not configured)"}
            </span>
          )}
          <Button variant="outline" onClick={() => void load()} disabled={loading} aria-label="Refresh">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
          </Button>
          <Button onClick={() => setDialog(tab === "quotes" ? "quote" : "invoice")}>
            <Plus className="h-4 w-4" aria-hidden /> New {tab === "quotes" ? "quote" : "invoice"}
          </Button>
        </div>
      </div>

      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}
      {notice && <Banner tone="info" onDismiss={() => setNotice(null)}>{notice}</Banner>}

      {loading && quotes.length === 0 && invoices.length === 0 ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden /> Loading…</div>
      ) : tab === "quotes" ? (
        <QuoteList quotes={quotes} busyId={busyId}
          onSend={(q) => act(q.id, async () => { const r = await api<{ url: string }>(`/api/quotes/${q.id}/send`, { method: "POST", body: "{}" }); return `Quote ${q.number} sent. Link: ${r.url}`; })}
          onConvert={(q) => act(q.id, async () => { const r = await api<{ invoice: Invoice }>(`/api/quotes/${q.id}/convert`, { method: "POST" }); setTab("invoices"); return `Created invoice ${r.invoice.number}.`; })}
          onDelete={(q) => act(q.id, async () => { await api(`/api/quotes/${q.id}`, { method: "DELETE" }); return `Deleted ${q.number}.`; })}
          onSuggest={(q) => act(q.id, async () => {
            const r = await api<{ suggestion: { items: Array<{ description: string; basis: string; suggested_min_minor: number | null; suggested_max_minor: number | null; expectedWinProbability: number }> } }>(`/api/quotes/${q.id}/pricing-suggestion`);
            const lines = r.suggestion.items.map((i) => i.basis === "history" && i.suggested_min_minor !== null && i.suggested_max_minor !== null
              ? `${i.description}: ${fmtMoney(i.suggested_min_minor, q.currency)}–${fmtMoney(i.suggested_max_minor, q.currency)} (win now ${Math.round(i.expectedWinProbability * 100)}%)`
              : `${i.description}: not enough history`);
            return `Pricing for ${q.number} — ${lines.join(" · ")}. Full detail on Insights → Pricing.`;
          })}
          onDecline={(q) => { if (!window.confirm(`Decline quote ${q.number}? Any reserved stock is released.`)) return; act(q.id, async () => { await api(`/api/quotes/${q.id}/decline`, { method: "POST", body: "{}" }); return `Declined ${q.number}.`; }); }}
        />
      ) : (
        <InvoiceList invoices={invoices} busyId={busyId} onCopy={copy}
          onSend={(i) => act(i.id, async () => { const r = await api<{ url: string }>(`/api/invoices/${i.id}/send`, { method: "POST", body: "{}" }); return `Invoice ${i.number} sent. Link: ${r.url}`; })}
          onPayLink={(i) => act(i.id, async () => { const r = await api<{ url: string }>(`/api/invoices/${i.id}/pay-link`, { method: "POST" }); await copy(r.url); return `Pay link for ${i.number}: ${r.url}`; })}
          onVoid={(i) => act(i.id, async () => { await api(`/api/invoices/${i.id}/void`, { method: "POST" }); return `Voided ${i.number}.`; })}
        />
      )}

      {dialog && (
        <NewDocDialog kind={dialog} onClose={() => setDialog(null)}
          onCreated={(msg) => { setDialog(null); setNotice(msg); void load(); }} />
      )}
    </PageContainer>
  );
}

function Banner({ tone, children, onDismiss }: { tone: "error" | "info" | "warn"; children: React.ReactNode; onDismiss?: () => void }) {
  const cls = tone === "error" ? "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
    : tone === "warn" ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
    : "border-border bg-secondary/40";
  return (
    <div className={cn("mb-4 flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-sm break-all", cls)} role={tone === "error" ? "alert" : "status"}>
      <div>{children}</div>
      {onDismiss && <button type="button" onClick={onDismiss} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100"><X className="h-4 w-4" /></button>}
    </div>
  );
}

function QuoteList({ quotes, busyId, onSend, onConvert, onDelete, onDecline, onSuggest }: {
  quotes: Quote[]; busyId: string | null;
  onSend: (q: Quote) => void; onConvert: (q: Quote) => void; onDelete: (q: Quote) => void; onDecline: (q: Quote) => void; onSuggest: (q: Quote) => void;
}) {
  if (quotes.length === 0) return <Empty icon={<Receipt className="h-6 w-6" />} text="No quotes yet. Create one to send to a client." />;
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {quotes.map((q) => {
        const busy = busyId === q.id;
        const canSend = ["draft", "sent", "viewed"].includes(q.status);
        return (
          <li key={q.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2"><span className="font-mono text-sm">{q.number}</span><StatusPill status={q.status} /></div>
              <p className="truncate text-sm text-muted-foreground">
                {q.contact_name ?? "No contact"}{q.contact_email ? ` · ${q.contact_email}` : ""} · {q.items.length} item{q.items.length === 1 ? "" : "s"} · {fmtDate(q.created_at)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="tabular-nums font-medium">{fmtMoney(q.total_minor, q.currency)}</span>
              {canSend && q.items.length > 0 && <Button size="sm" variant="outline" disabled={busy} onClick={() => onSuggest(q)} title="Compare these prices with past accepted and declined quotes"><Sparkles className="h-3.5 w-3.5" /> Suggest pricing</Button>}
              {canSend && <Button size="sm" variant="outline" disabled={busy} onClick={() => onSend(q)} title="Email a share link"><Send className="h-3.5 w-3.5" /> Send</Button>}
              {q.status !== "draft" && <Button size="sm" variant="outline" disabled={busy} onClick={() => onConvert(q)} title="Create an invoice from this quote"><FileCheck2 className="h-3.5 w-3.5" /> Invoice</Button>}
              <Button asChild size="sm" variant="outline" title={q.status === "accepted" ? "Download the signed PDF" : "Download PDF"}>
                <a href={`/api/quotes/${q.id}/pdf`} target="_blank" rel="noopener" aria-label={`Download PDF for ${q.number}`}><FileDown className="h-3.5 w-3.5" /> PDF</a>
              </Button>
              {["sent", "viewed"].includes(q.status) && <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecline(q)} aria-label={`Decline ${q.number}`} title="Mark as declined and release reserved stock"><XCircle className="h-3.5 w-3.5" /></Button>}
              {q.status === "draft" && <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDelete(q)} aria-label="Delete draft"><Trash2 className="h-3.5 w-3.5" /></Button>}
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function InvoiceList({ invoices, busyId, onSend, onPayLink, onVoid, onCopy }: {
  invoices: Invoice[]; busyId: string | null;
  onSend: (i: Invoice) => void; onPayLink: (i: Invoice) => void; onVoid: (i: Invoice) => void; onCopy: (t: string) => void;
}) {
  if (invoices.length === 0) return <Empty icon={<Receipt className="h-6 w-6" />} text="No invoices yet. Convert an accepted quote or create one directly." />;
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {invoices.map((i) => {
        const busy = busyId === i.id;
        const open = !["paid", "void"].includes(i.status);
        return (
          <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2"><span className="font-mono text-sm">{i.number}</span><StatusPill status={i.status} /></div>
              <p className="truncate text-sm text-muted-foreground">
                {i.contact_name ?? "No contact"}{i.contact_email ? ` · ${i.contact_email}` : ""} · due {fmtDate(i.due_at)}
                {i.paid_minor > 0 && ` · paid ${fmtMoney(i.paid_minor, i.currency)}`}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="tabular-nums font-medium">{fmtMoney(i.total_minor, i.currency)}</span>
              {open && <Button size="sm" variant="outline" disabled={busy} onClick={() => onSend(i)}><Send className="h-3.5 w-3.5" /> Send</Button>}
              {open && <Button size="sm" variant="outline" disabled={busy} onClick={() => onPayLink(i)} title="Create and copy a payment link"><Link2 className="h-3.5 w-3.5" /> Pay link</Button>}
              {open && <Button size="sm" variant="ghost" disabled={busy} onClick={() => onVoid(i)} aria-label="Void invoice"><Ban className="h-3.5 w-3.5" /></Button>}
              <Button size="sm" variant="ghost" onClick={() => onCopy(i.number)} aria-label="Copy invoice number"><Copy className="h-3.5 w-3.5" /></Button>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Empty({ icon, text }: { icon: React.ReactNode; text: string }) {
  return <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-14 text-center text-sm text-muted-foreground">{icon}<p>{text}</p></div>;
}

const BLANK: LineItem = { description: "", qty: 1, unit_minor: 0, tax_rate_bp: 0 };

function NewDocDialog({ kind, onClose, onCreated }: { kind: "quote" | "invoice"; onClose: () => void; onCreated: (msg: string) => void }) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactId, setContactId] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [items, setItems] = useState<LineItem[]>([{ ...BLANK }]);
  const [notes, setNotes] = useState("");
  const [date, setDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/crm/contacts").then((r) => r.json()).then((d) => setContacts(d.contacts ?? [])).catch(() => setContacts([]));
  }, []);

  const totals = useMemo(() => computeTotalsClient(items), [items]);

  function setItem(i: number, patch: Partial<LineItem>) {
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  }

  async function submit() {
    setSaving(true); setError(null);
    try {
      const clean = items.filter((it) => it.description.trim());
      if (clean.length === 0) throw new Error("Add at least one line item.");
      const body: Record<string, unknown> = { contact_id: contactId || null, currency, items: clean, notes: notes || null };
      if (date) body[kind === "quote" ? "valid_until" : "due_at"] = new Date(date + "T23:59:59").toISOString();
      const path = kind === "quote" ? "/api/quotes" : "/api/invoices";
      const r = await api<{ quote?: { number: string }; invoice?: { number: string } }>(path, { method: "POST", body: JSON.stringify(body) });
      onCreated(`Created ${r.quote?.number ?? r.invoice?.number ?? kind}.`);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not create."); }
    finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={`New ${kind}`}>
      <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-xl bg-background p-5 shadow-xl sm:rounded-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">New {kind}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="opacity-70 hover:opacity-100"><X className="h-5 w-5" /></button>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-sm sm:col-span-2">
            <span className="mb-1 block font-medium">Contact</span>
            <select value={contactId} onChange={(e) => setContactId(e.target.value)} className="flex h-9 w-full rounded-md border border-border bg-secondary/40 px-3 text-sm">
              <option value="">— none —</option>
              {contacts.map((c) => <option key={c.id} value={c.id}>{c.full_name}{c.company ? ` (${c.company})` : ""}{c.email ? ` · ${c.email}` : ""}</option>)}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">Currency</span>
            <Input value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
          </label>
          <label className="text-sm sm:col-span-3">
            <span className="mb-1 block font-medium">{kind === "quote" ? "Valid until" : "Due date"}</span>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        </div>

        <div className="mt-4">
          <div className="mb-1 grid grid-cols-12 gap-2 text-xs uppercase tracking-wide text-muted-foreground">
            <span className="col-span-6">Description</span><span className="col-span-2">Qty</span><span className="col-span-2">Unit price</span><span className="col-span-2">Tax %</span>
          </div>
          {items.map((it, i) => (
            <div key={i} className="mb-2 grid grid-cols-12 gap-2">
              <Input className="col-span-6" placeholder="Service or product" value={it.description} onChange={(e) => setItem(i, { description: e.target.value })} />
              <Input className="col-span-2" type="number" min={0} step="0.01" value={it.qty} onChange={(e) => setItem(i, { qty: Number(e.target.value) || 0 })} />
              <Input className="col-span-2" type="number" min={0} step="0.01" value={(it.unit_minor / 100).toString()} onChange={(e) => setItem(i, { unit_minor: Math.round((Number(e.target.value) || 0) * 100) })} />
              <div className="col-span-2 flex gap-1">
                <Input type="number" min={0} max={100} step="0.01" value={(it.tax_rate_bp / 100).toString()} onChange={(e) => setItem(i, { tax_rate_bp: Math.round((Number(e.target.value) || 0) * 100) })} />
                <button type="button" onClick={() => setItems((p) => p.filter((_, idx) => idx !== i))} aria-label="Remove line" className="opacity-60 hover:opacity-100" disabled={items.length === 1}><X className="h-4 w-4" /></button>
              </div>
            </div>
          ))}
          <Button size="sm" variant="ghost" onClick={() => setItems((p) => [...p, { ...BLANK }])}><Plus className="h-3.5 w-3.5" /> Add line</Button>
        </div>

        <label className="mt-4 block text-sm">
          <span className="mb-1 block font-medium">Notes</span>
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Visible to the client" />
        </label>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <div className="text-sm text-muted-foreground">
            Subtotal {fmtMoney(totals.subtotal_minor, currency)} · Tax {fmtMoney(totals.tax_minor, currency)} · <span className="font-semibold text-foreground">Total {fmtMoney(totals.total_minor, currency)}</span>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button onClick={() => void submit()} disabled={saving}>{saving && <Loader2 className="h-4 w-4 animate-spin" />} Create {kind}</Button>
          </div>
        </div>
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
}
