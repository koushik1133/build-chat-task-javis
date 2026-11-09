"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Ban, Copy, FileCheck2, FileDown, FileMinus, Link2, Loader2, Plus, Receipt, RefreshCw, RotateCcw, Send, Sparkles, Trash2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Pill, type Tone } from "@/components/ui/pill";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Banner, Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { isAbortError, useAbortable } from "@/components/ui/hooks";
import { PageContainer } from "@/components/page-container";
import { fmtDate, fmtMoney } from "@/lib/money/format";
import { BLANK_ITEM, LineItemsEditor, StatusPill, TotalsSummary, useDocTotals, useTaxRates, type LineItem } from "@/components/billing/shared";
import { RecurringTab } from "@/components/billing/recurring-tab";
import { SettingsTab } from "@/components/billing/settings-tab";
import { CreditNoteDialog, CreditNoteList, RefundDialog, type CreditNote } from "@/components/billing/credit-notes";

interface Contact { id: string; full_name: string; email: string | null; company: string | null }
interface Quote {
  id: string; number: string; status: string; currency: string; total_minor: number; contact_name: string | null;
  contact_email: string | null; items: LineItem[]; valid_until: string | null; created_at: string; sent_at: string | null;
}
interface Invoice {
  id: string; number: string; status: string; currency: string; total_minor: number; paid_minor: number; contact_name: string | null;
  contact_email: string | null; items: LineItem[]; due_at: string | null; created_at: string; quote_id: string | null; reminder_count: number;
}
interface ProviderInfo { id: string; configured: boolean; active: boolean }
type SyncState = "synced" | "pending" | "error";
const SYNC_TONE: Record<SyncState, Tone> = { synced: "success", pending: "info", error: "danger" };

type Tab = "quotes" | "invoices" | "recurring" | "settings";
type InvoiceView = "invoices" | "credit_notes";
type Notice = { tone: "success" | "info" | "error"; text: string };

const spinner = <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.detail?.formErrors?.[0] ?? (typeof data?.detail === "string" ? data.detail : null) ?? data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

export default function BillingPage() {
  const [tab, setTab] = useState<Tab>("quotes");
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [dialog, setDialog] = useState<null | "quote" | "invoice">(null);
  const [creditFor, setCreditFor] = useState<Invoice | null>(null);
  const [refundFor, setRefundFor] = useState<Invoice | null>(null);
  const [creditNotes, setCreditNotes] = useState<CreditNote[]>([]);
  const [invoiceView, setInvoiceView] = useState<InvoiceView>("invoices");
  const [busyId, setBusyId] = useState<string | null>(null);
  // Accounting sync pills: only when a ledger is connected (one fetch, then the invoice links).
  const [syncState, setSyncState] = useState<Record<string, SyncState> | null>(null);
  const nextSignal = useAbortable();
  const router = useRouter();

  // Deep link from Home quick actions: /billing?new=quote|invoice opens the dialog once, then the URL is cleaned.
  useEffect(() => {
    const want = new URLSearchParams(window.location.search).get("new");
    if (want !== "quote" && want !== "invoice") return;
    setTab(want === "quote" ? "quotes" : "invoices");
    setDialog(want);
    router.replace("/billing", { scroll: false });
  }, [router]);

  const load = useCallback(async () => {
    const signal = nextSignal();
    setLoading(true);
    setError(null);
    try {
      const [q, i, cn] = await Promise.all([
        api<{ quotes: Quote[] }>("/api/quotes", { signal }),
        api<{ invoices: Invoice[]; providers: ProviderInfo[] }>("/api/invoices", { signal }),
        api<{ credit_notes: CreditNote[] }>("/api/credit-notes", { signal }).catch(() => ({ credit_notes: [] as CreditNote[] })),
      ]);
      setQuotes(q.quotes);
      setInvoices(i.invoices);
      setProviders(i.providers);
      setCreditNotes(cn.credit_notes);
      void (async () => {
        try {
          const c = await api<{ connections: Array<{ status: string }> }>("/api/accounting/connections", { signal });
          if (!c.connections.some((x) => x.status !== "disabled")) return setSyncState(null);
          const l = await api<{ links: Array<{ entity_id: string; state: SyncState }> }>("/api/accounting/links?kind=invoice", { signal });
          const map: Record<string, SyncState> = {};
          for (const link of l.links) if (!(link.entity_id in map) || link.state === "error") map[link.entity_id] = link.state;
          setSyncState(map);
        } catch {
          /* pills are decorative; never block billing */
        }
      })();
    } catch (e) {
      if (isAbortError(e)) return;
      setError(e instanceof Error ? e.message : "Could not load billing.");
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
      setNotice(null);
      try {
        const msg = await fn();
        if (msg) setNotice({ tone: "success", text: msg });
        await load();
      } catch (e) {
        setNotice({ tone: "error", text: e instanceof Error ? e.message : "Action failed." });
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice({ tone: "success", text: "Link copied to clipboard." });
    } catch {
      setNotice({ tone: "info", text });
    }
  }, []);

  const tabs = useMemo(
    () => [
      { id: "quotes" as const, label: "Quotes", count: quotes.length },
      { id: "invoices" as const, label: "Invoices", count: invoices.length },
      { id: "recurring" as const, label: "Recurring" },
      { id: "settings" as const, label: "Settings" },
    ],
    [quotes.length, invoices.length]
  );
  const active = providers.find((p) => p.active);
  const empty = quotes.length === 0 && invoices.length === 0;

  return (
    <PageContainer
      wide
      title="Billing"
      description="Quotes your clients can accept online, invoices they can pay, and the money that came in."
      tooltip="Send a quote, get it accepted with email verification, convert it to an invoice and collect payment through a share link."
      className="pb-24"
      actions={
        <>
          <Button variant="outline" size="icon" touch onClick={() => void load()} disabled={loading} aria-label="Refresh billing">
            {loading ? spinner : <RefreshCw className="h-4 w-4" aria-hidden />}
          </Button>
          {(tab === "quotes" || tab === "invoices") && (
            <Button touch onClick={() => setDialog(tab === "quotes" ? "quote" : "invoice")}>
              <Plus className="h-4 w-4" aria-hidden /> New {tab === "quotes" ? "quote" : "invoice"}
            </Button>
          )}
        </>
      }
    >
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs id="billing" label="Billing section" tabs={tabs} value={tab} onChange={setTab} className="w-full sm:w-fit" />
        {active && (
          <p className="text-xs text-muted-foreground">
            Payments: <span className="font-medium capitalize">{active.id}</span>
            {!active.configured && " (not configured)"}
          </p>
        )}
      </div>

      {error && !empty && (
        <Banner tone="error" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}
      {notice && (
        <Banner tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Banner>
      )}

      <TabPanel id="billing" value={tab}>
        <div aria-busy={loading || undefined}>
          {loading && empty ? (
            <Loading label="Loading billing…" className="rounded-xl border border-border bg-card" />
          ) : error && empty ? (
            <ErrorState message={error} onRetry={() => void load()} />
          ) : tab === "quotes" ? (
            <QuoteList
              quotes={quotes}
              busyId={busyId}
              onNew={() => setDialog("quote")}
              onSend={(q) =>
                act(q.id, async () => {
                  const r = await api<{ url: string }>(`/api/quotes/${q.id}/send`, { method: "POST", body: "{}" });
                  return `Quote ${q.number} sent. Link: ${r.url}`;
                })
              }
              onConvert={(q) =>
                act(q.id, async () => {
                  const r = await api<{ invoice: Invoice }>(`/api/quotes/${q.id}/convert`, { method: "POST" });
                  setTab("invoices");
                  return `Created invoice ${r.invoice.number}.`;
                })
              }
              onDelete={(q) =>
                act(q.id, async () => {
                  await api(`/api/quotes/${q.id}`, { method: "DELETE" });
                  return `Deleted ${q.number}.`;
                })
              }
              onSuggest={(q) =>
                act(q.id, async () => {
                  const r = await api<{ suggestion: { items: Array<{ description: string; basis: string; suggested_min_minor: number | null; suggested_max_minor: number | null; expectedWinProbability: number }> } }>(`/api/quotes/${q.id}/pricing-suggestion`);
                  const lines = r.suggestion.items.map((i) =>
                    i.basis === "history" && i.suggested_min_minor !== null && i.suggested_max_minor !== null
                      ? `${i.description}: ${fmtMoney(i.suggested_min_minor, q.currency)}–${fmtMoney(i.suggested_max_minor, q.currency)} (win now ${Math.round(i.expectedWinProbability * 100)}%)`
                      : `${i.description}: not enough history`
                  );
                  return `Pricing for ${q.number} — ${lines.join(" · ")}. Full detail on Insights → Pricing.`;
                })
              }
              onDecline={(q) => {
                if (!window.confirm(`Decline quote ${q.number}? Any reserved stock is released.`)) return;
                void act(q.id, async () => {
                  await api(`/api/quotes/${q.id}/decline`, { method: "POST", body: "{}" });
                  return `Declined ${q.number}.`;
                });
              }}
            />
          ) : tab === "recurring" ? (
            <RecurringTab onNotice={setNotice} onInvoiceCreated={() => void load()} />
          ) : tab === "settings" ? (
            <SettingsTab onNotice={setNotice} />
          ) : (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2 text-xs" role="group" aria-label="Invoice view">
                <Button size="sm" variant={invoiceView === "invoices" ? "default" : "outline"} touch onClick={() => setInvoiceView("invoices")} aria-pressed={invoiceView === "invoices"}>Invoices</Button>
                <Button size="sm" variant={invoiceView === "credit_notes" ? "default" : "outline"} touch onClick={() => setInvoiceView("credit_notes")} aria-pressed={invoiceView === "credit_notes"}>
                  Credit notes{creditNotes.length > 0 ? ` (${creditNotes.length})` : ""}
                </Button>
              </div>
              {invoiceView === "credit_notes" ? (
                <CreditNoteList
                  notes={creditNotes}
                  busyId={busyId}
                  onIssue={(n) => act(n.id, async () => {
                    await api(`/api/credit-notes/${n.id}/issue`, { method: "POST" });
                    return `Issued ${n.number}.`;
                  })}
                  onDelete={(n) => act(n.id, async () => {
                    await api(`/api/credit-notes/${n.id}`, { method: "DELETE" });
                    return `Deleted ${n.number}.`;
                  })}
                />
              ) : (
            <InvoiceList
              invoices={invoices}
              syncState={syncState}
              busyId={busyId}
              onNew={() => setDialog("invoice")}
              onCopy={copy}
              onCreditNote={(i) => setCreditFor(i)}
              onRefund={(i) => setRefundFor(i)}
              onSend={(i) =>
                act(i.id, async () => {
                  const r = await api<{ url: string }>(`/api/invoices/${i.id}/send`, { method: "POST", body: "{}" });
                  return `Invoice ${i.number} sent. Link: ${r.url}`;
                })
              }
              onPayLink={(i) =>
                act(i.id, async () => {
                  const r = await api<{ url: string }>(`/api/invoices/${i.id}/pay-link`, { method: "POST" });
                  await copy(r.url);
                  return `Pay link for ${i.number}: ${r.url}`;
                })
              }
              onVoid={(i) => {
                if (!window.confirm(`Void invoice ${i.number}? This cannot be undone.`)) return;
                void act(i.id, async () => {
                  await api(`/api/invoices/${i.id}/void`, { method: "POST" });
                  return `Voided ${i.number}.`;
                });
              }}
            />
              )}
            </>
          )}
        </div>
      </TabPanel>

      {creditFor && (
        <CreditNoteDialog
          invoice={creditFor}
          onClose={() => setCreditFor(null)}
          onCreated={(msg) => {
            setCreditFor(null);
            setNotice({ tone: "success", text: msg });
            setInvoiceView("credit_notes");
            void load();
          }}
        />
      )}
      {refundFor && (
        <RefundDialog
          invoice={refundFor}
          onClose={() => setRefundFor(null)}
          onDone={(msg) => {
            setRefundFor(null);
            setNotice({ tone: "success", text: msg });
            void load();
          }}
        />
      )}

      {dialog && (
        <NewDocDialog
          kind={dialog}
          onClose={() => setDialog(null)}
          onCreated={(msg) => {
            setDialog(null);
            setNotice({ tone: "success", text: msg });
            void load();
          }}
        />
      )}
    </PageContainer>
  );
}

/* ───────────────────────── lists ───────────────────────── */

function QuoteList({ quotes, busyId, onNew, onSend, onConvert, onDelete, onDecline, onSuggest }: {
  quotes: Quote[]; busyId: string | null; onNew: () => void;
  onSend: (q: Quote) => void; onConvert: (q: Quote) => void; onDelete: (q: Quote) => void; onDecline: (q: Quote) => void; onSuggest: (q: Quote) => void;
}) {
  if (quotes.length === 0) {
    return (
      <Empty
        icon={<Receipt className="h-5 w-5" />}
        title="No quotes yet"
        text="Create a quote, send the share link and your client can accept and sign it online."
        action={
          <Button touch onClick={onNew}>
            <Plus className="h-4 w-4" aria-hidden /> New quote
          </Button>
        }
      />
    );
  }
  return (
    <ul className="divide-y divide-border rounded-xl border border-border bg-card" aria-label="Quotes">
      {quotes.map((q) => (
        <QuoteRow key={q.id} q={q} busy={busyId === q.id} onSend={onSend} onConvert={onConvert} onDelete={onDelete} onDecline={onDecline} onSuggest={onSuggest} />
      ))}
    </ul>
  );
}

const QuoteRow = memo(function QuoteRow({ q, busy, onSend, onConvert, onDelete, onDecline, onSuggest }: {
  q: Quote; busy: boolean;
  onSend: (q: Quote) => void; onConvert: (q: Quote) => void; onDelete: (q: Quote) => void; onDecline: (q: Quote) => void; onSuggest: (q: Quote) => void;
}) {
  const canSend = ["draft", "sent", "viewed"].includes(q.status);
  return (
    <li className="flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center lg:justify-between" aria-busy={busy || undefined}>
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm">{q.number}</span>
            <StatusPill status={q.status} />
          </div>
          <p className="mt-0.5 truncate text-sm text-muted-foreground">
            {q.contact_name ?? "No contact"}
            {q.contact_email ? ` · ${q.contact_email}` : ""} · {q.items.length} item{q.items.length === 1 ? "" : "s"} · {fmtDate(q.created_at)}
          </p>
        </div>
        <span className="shrink-0 font-medium tabular-nums lg:hidden">{fmtMoney(q.total_minor, q.currency)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 hidden font-medium tabular-nums lg:inline">{fmtMoney(q.total_minor, q.currency)}</span>
        {canSend && q.items.length > 0 && (
          <Button size="sm" variant="outline" touch disabled={busy} onClick={() => onSuggest(q)} title="Compare these prices with past accepted and declined quotes">
            <Sparkles className="h-3.5 w-3.5" aria-hidden /> Suggest pricing
          </Button>
        )}
        {canSend && (
          <Button size="sm" variant="outline" touch disabled={busy} onClick={() => onSend(q)} title="Email a share link">
            <Send className="h-3.5 w-3.5" aria-hidden /> Send
          </Button>
        )}
        {q.status !== "draft" && (
          <Button size="sm" variant="outline" touch disabled={busy} onClick={() => onConvert(q)} title="Create an invoice from this quote">
            <FileCheck2 className="h-3.5 w-3.5" aria-hidden /> Invoice
          </Button>
        )}
        <Button asChild size="sm" variant="outline" touch title={q.status === "accepted" ? "Download the signed PDF" : "Download PDF"}>
          <a href={`/api/quotes/${q.id}/pdf`} target="_blank" rel="noopener" aria-label={`Download PDF for ${q.number}`}>
            <FileDown className="h-3.5 w-3.5" aria-hidden /> PDF
          </a>
        </Button>
        {["sent", "viewed"].includes(q.status) && (
          <Button size="sm" variant="ghost" touch disabled={busy} onClick={() => onDecline(q)} aria-label={`Decline ${q.number}`} title="Mark as declined and release reserved stock">
            <XCircle className="h-3.5 w-3.5" aria-hidden />
          </Button>
        )}
        {q.status === "draft" && (
          <Button size="sm" variant="ghost" touch disabled={busy} onClick={() => onDelete(q)} aria-label={`Delete draft ${q.number}`}>
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          </Button>
        )}
        {busy && (
          <span role="status" className="inline-flex items-center">
            {spinner}
            <span className="sr-only">Working…</span>
          </span>
        )}
      </div>
    </li>
  );
});

function InvoiceList({ invoices, syncState, busyId, onNew, onSend, onPayLink, onVoid, onCopy, onCreditNote, onRefund }: {
  invoices: Invoice[]; syncState: Record<string, SyncState> | null; busyId: string | null; onNew: () => void;
  onSend: (i: Invoice) => void; onPayLink: (i: Invoice) => void; onVoid: (i: Invoice) => void; onCopy: (t: string) => void;
  onCreditNote: (i: Invoice) => void; onRefund: (i: Invoice) => void;
}) {
  if (invoices.length === 0) {
    return (
      <Empty
        icon={<Receipt className="h-5 w-5" />}
        title="No invoices yet"
        text="Convert an accepted quote into an invoice, or create one directly and share a pay link."
        action={
          <Button touch onClick={onNew}>
            <Plus className="h-4 w-4" aria-hidden /> New invoice
          </Button>
        }
      />
    );
  }
  return (
    <ul className="divide-y divide-border rounded-xl border border-border bg-card" aria-label="Invoices">
      {invoices.map((i) => (
        <InvoiceRow key={i.id} i={i} sync={syncState ? (syncState[i.id] ?? (i.status === "draft" || i.status === "void" ? null : "pending")) : null} busy={busyId === i.id} onSend={onSend} onPayLink={onPayLink} onVoid={onVoid} onCopy={onCopy} onCreditNote={onCreditNote} onRefund={onRefund} />
      ))}
    </ul>
  );
}

const InvoiceRow = memo(function InvoiceRow({ i, sync, busy, onSend, onPayLink, onVoid, onCopy, onCreditNote, onRefund }: {
  i: Invoice; sync: SyncState | null; busy: boolean;
  onSend: (i: Invoice) => void; onPayLink: (i: Invoice) => void; onVoid: (i: Invoice) => void; onCopy: (t: string) => void;
  onCreditNote: (i: Invoice) => void; onRefund: (i: Invoice) => void;
}) {
  const open = !["paid", "void"].includes(i.status);
  const issued = !["draft", "void"].includes(i.status);
  return (
    <li className="flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center lg:justify-between" aria-busy={busy || undefined}>
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm">{i.number}</span>
            <StatusPill status={i.status} />
            {sync && <Pill tone={SYNC_TONE[sync]} title="Accounting sync">{sync === "synced" ? "Synced" : sync === "error" ? "Sync error" : "Pending"}</Pill>}
          </div>
          <p className="mt-0.5 truncate text-sm text-muted-foreground">
            {i.contact_name ?? "No contact"}
            {i.contact_email ? ` · ${i.contact_email}` : ""} · due {fmtDate(i.due_at)}
            {i.paid_minor > 0 && ` · paid ${fmtMoney(i.paid_minor, i.currency)}`}
            {i.status === "overdue" && i.reminder_count > 0 && ` · ${i.reminder_count} reminder${i.reminder_count === 1 ? "" : "s"} sent`}
          </p>
        </div>
        <span className="shrink-0 font-medium tabular-nums lg:hidden">{fmtMoney(i.total_minor, i.currency)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 hidden font-medium tabular-nums lg:inline">{fmtMoney(i.total_minor, i.currency)}</span>
        {open && (
          <Button size="sm" variant="outline" touch disabled={busy} onClick={() => onSend(i)}>
            <Send className="h-3.5 w-3.5" aria-hidden /> Send
          </Button>
        )}
        {open && (
          <Button size="sm" variant="outline" touch disabled={busy} onClick={() => onPayLink(i)} title="Create and copy a payment link">
            <Link2 className="h-3.5 w-3.5" aria-hidden /> Pay link
          </Button>
        )}
        {issued && (
          <Button size="sm" variant="outline" touch disabled={busy} onClick={() => onCreditNote(i)} title="Credit part or all of this invoice">
            <FileMinus className="h-3.5 w-3.5" aria-hidden /> Credit note
          </Button>
        )}
        {i.paid_minor > 0 && (
          <Button size="sm" variant="outline" touch disabled={busy} onClick={() => onRefund(i)} title="Refund a recorded payment">
            <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Refund
          </Button>
        )}
        <Button asChild size="sm" variant="outline" touch title="Download PDF">
          <a href={`/api/invoices/${i.id}/pdf`} target="_blank" rel="noopener" aria-label={`Download PDF for ${i.number}`}>
            <FileDown className="h-3.5 w-3.5" aria-hidden /> PDF
          </a>
        </Button>
        {open && (
          <Button size="sm" variant="ghost" touch disabled={busy} onClick={() => onVoid(i)} aria-label={`Void invoice ${i.number}`}>
            <Ban className="h-3.5 w-3.5" aria-hidden />
          </Button>
        )}
        <Button size="sm" variant="ghost" touch onClick={() => onCopy(i.number)} aria-label={`Copy invoice number ${i.number}`}>
          <Copy className="h-3.5 w-3.5" aria-hidden />
        </Button>
        {busy && (
          <span role="status" className="inline-flex items-center">
            {spinner}
            <span className="sr-only">Working…</span>
          </span>
        )}
      </div>
    </li>
  );
});

/* ───────────────────────── new quote / invoice ───────────────────────── */

function NewDocDialog({ kind, onClose, onCreated }: { kind: "quote" | "invoice"; onClose: () => void; onCreated: (msg: string) => void }) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactId, setContactId] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [items, setItems] = useState<LineItem[]>([{ ...BLANK_ITEM }]);
  const [notes, setNotes] = useState("");
  const [date, setDate] = useState("");
  const [terms, setTerms] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { rates, inclusive, rounding } = useTaxRates();
  const totalOpts = useMemo(() => ({ inclusive, rounding }), [inclusive, rounding]);
  const totals = useDocTotals(items, rates, totalOpts);
  // Pre-select the default catalogue rate on the first blank line once rates arrive.
  useEffect(() => {
    const def = rates.find((r) => r.is_default);
    if (!def) return;
    setItems((prev) => (prev.length === 1 && !prev[0].description && !prev[0].tax_rate_id ? [{ ...prev[0], tax_rate_id: def.id }] : prev));
  }, [rates]);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/crm/contacts?limit=200", { signal: ctrl.signal })
      .then((r) => r.json())
      .then((d) => setContacts(d.contacts ?? []))
      .catch(() => setContacts([]));
    return () => ctrl.abort();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const clean = items.filter((it) => it.description.trim());
      if (clean.length === 0) throw new Error("Add at least one line item.");
      const body: Record<string, unknown> = { contact_id: contactId || null, currency, items: clean, notes: notes || null };
      if (date) body[kind === "quote" ? "valid_until" : "due_at"] = new Date(date + "T23:59:59").toISOString();
      if (kind === "invoice" && terms !== "") body.terms_days = Number(terms);
      const path = kind === "quote" ? "/api/quotes" : "/api/invoices";
      const r = await api<{ quote?: { number: string }; invoice?: { number: string } }>(path, { method: "POST", body: JSON.stringify(body) });
      onCreated(`Created ${r.quote?.number ?? r.invoice?.number ?? kind}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title={kind === "quote" ? "New quote" : "New invoice"} onClose={onClose} size="lg">
      <form onSubmit={submit} className="space-y-4">
        {error && (
          <Banner tone="error" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Contact" className="sm:col-span-2">
            <Select value={contactId} onChange={(e) => setContactId(e.target.value)}>
              <option value="">No contact</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.full_name}
                  {c.company ? ` (${c.company})` : ""}
                  {c.email ? ` · ${c.email}` : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Currency" hint="Three-letter code">
            <Input value={currency} maxLength={3} autoCapitalize="characters" onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
          </Field>
          <Field label={kind === "quote" ? "Valid until" : "Due date"} className={kind === "quote" ? "sm:col-span-3" : "sm:col-span-2"} hint={kind === "invoice" ? "Leave blank to use payment terms" : undefined}>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          {kind === "invoice" && (
            <Field label="Terms (days)" hint="Blank = org default">
              <Input type="number" min={0} max={365} value={terms} onChange={(e) => setTerms(e.target.value)} />
            </Field>
          )}
        </div>

        <LineItemsEditor items={items} onChange={setItems} rates={rates} currency={currency} />

        <Field label="Notes" hint="Visible to the client">
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        <DialogFooter start={<TotalsSummary totals={totals} currency={currency} inclusive={inclusive} />}>
          <Button type="button" variant="ghost" touch onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" touch disabled={saving}>
            {saving && spinner} Create {kind}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
