"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, ChevronRight, Landmark, Loader2, RefreshCw, Send, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Banner, Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { Checkbox, Input, Select } from "@/components/ui/input";
import { Pill, type Tone } from "@/components/ui/pill";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { isAbortError, useAbortable } from "@/components/ui/hooks";
import { PageContainer } from "@/components/page-container";
import type { AccountOption, AccountingConnectionView, AccountingEntityKind, AccountingSettings, AccountingSyncLogRow, LiveAccountingProviderId } from "@/lib/accounting/types";
import type { LiveProviderInfo } from "@/lib/accounting/connections";
import { cn, timeAgo } from "@/lib/utils";

type Notice = { tone: "success" | "error" | "info"; text: string };
type Detail = { connection: Omit<AccountingConnectionView, "counts">; accounts: AccountOption[]; accountsError: string | null; simulated: Array<{ id: string; kind: string; remote_id: string; source: string; payload: unknown; updated_at: string }> };

const STATUS_TONE: Record<string, Tone> = { connected: "success", error: "danger", disabled: "neutral" };
const LOG_TONE: Record<string, Tone> = { ok: "success", error: "danger", skipped: "neutral" };
const KINDS: AccountingEntityKind[] = ["invoice", "payment", "expense", "contact", "product", "supplier", "bill", "bill_payment"];

const spinner = <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />;
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const fmt =(iso: string | null) => (iso ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)) : "—");

async function readError(res: Response, fallback: string): Promise<string> {
  const d = await res.json().catch(() => null);
  return d && (d.detail?.formErrors?.[0] || d.error) ? String(d.detail?.formErrors?.[0] ?? d.error) : `${fallback} (${res.status})`;
}

export default function AccountingSettingsPage() {
  return (
    <Suspense fallback={<PageContainer wide title="Accounting"><Loading label="Loading accounting…" /></PageContainer>}>
      <AccountingSettings />
    </Suspense>
  );
}

function AccountingSettings() {
  const router = useRouter();
  const search = useSearchParams();
  const nextSignal = useAbortable();
  const [connections, setConnections] = useState<AccountingConnectionView[]>([]);
  const [providers, setProviders] = useState<LiveProviderInfo[]>([]);
  const [migrated, setMigrated] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [disconnect, setDisconnect] = useState<AccountingConnectionView | null>(null);

  const load = useCallback(async () => {
    const signal = nextSignal();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/accounting/connections", { signal });
      if (!res.ok) throw new Error(await readError(res, "Could not load accounting"));
      const data = (await res.json()) as { connections: AccountingConnectionView[]; providers: LiveProviderInfo[]; migrated: boolean };
      setConnections(data.connections);
      setProviders(data.providers);
      setMigrated(data.migrated);
      setSelected((cur) => cur && data.connections.some((c) => c.id === cur) ? cur : (data.connections[0]?.id ?? null));
    } catch (err) {
      if (isAbortError(err)) return;
      setError(err instanceof Error ? err.message : "Could not load accounting.");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [nextSignal]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const connected = search.get("connected");
    const err = search.get("error");
    const conn = search.get("connection");
    if (!connected && !err) return;
    if (err) setNotice({ tone: "error", text: err });
    else setNotice({ tone: "success", text: `${connected === "simulated" ? "Simulated ledger" : connected === "xero" ? "Xero" : "QuickBooks"} connected. Choose your account mappings below, then sync.` });
    if (conn) setSelected(conn);
    router.replace("/settings/accounting");
  }, [search, router]);

  async function syncNow(c: AccountingConnectionView) {
    setBusy(`sync:${c.id}`);
    setNotice(null);
    try {
      const res = await fetch(`/api/accounting/connections/${encodeURIComponent(c.id)}`, { method: "POST" });
      if (!res.ok) throw new Error(await readError(res, "Sync failed"));
      const d = (await res.json()) as { push: { pushed: number; skipped: number; errors: number }; pull: { recorded: number; skipped: number; errors: number } };
      setNotice({ tone: d.push.errors || d.pull.errors ? "error" : "success", text: `Pushed ${d.push.pushed} (${d.push.skipped} unchanged, ${d.push.errors} failed) · pulled ${d.pull.recorded} payment(s) (${d.pull.errors} failed).` });
      await load();
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Sync failed." });
    } finally {
      setBusy(null);
    }
  }

  async function confirmDisconnect() {
    if (!disconnect) return;
    setBusy(`del:${disconnect.id}`);
    try {
      const res = await fetch(`/api/accounting/connections?id=${encodeURIComponent(disconnect.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await readError(res, "Could not disconnect."));
      setNotice({ tone: "info", text: `${disconnect.company_name ?? disconnect.provider} disconnected. Records already in the ledger were left as they are.` });
      setDisconnect(null);
      await load();
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Could not disconnect." });
    } finally {
      setBusy(null);
    }
  }

  const current = connections.find((c) => c.id === selected) ?? null;

  return (
    <PageContainer
      wide
      title="Accounting"
      icon={<Landmark className="h-5 w-5" aria-hidden />}
      description="Keep your books in step: invoices, payments and expenses flow into QuickBooks or Xero, and payments recorded there come back."
      tooltip="Invoices are pushed when sent or paid, expenses when created, payments right after their invoice. Every few minutes the ledger is polled for payments entered there so an invoice can be marked paid without touching KernelHub."
      actions={
        <Button asChild variant="outline" touch>
          <Link href="/reports">Export CSV instead</Link>
        </Button>
      }
    >
      {notice && <Banner tone={notice.tone === "success" ? "success" : notice.tone === "error" ? "error" : "info"} onDismiss={() => setNotice(null)}>{notice.text}</Banner>}
      {!migrated && !loading && <Banner tone="warn">The accounting tables are not in this database yet. Apply <code>aws/phase5/b.sql</code> and reload.</Banner>}

      <section aria-labelledby="providers-heading" className="mb-6">
        <h2 id="providers-heading" className="mb-2 text-sm font-semibold">Ledgers</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {providers.map((p) => (
            <ProviderCard key={p.id} p={p} connected={connections.filter((c) => c.provider === p.id)} disabled={!migrated || busy !== null} />
          ))}
        </div>
      </section>

      {loading ? (
        <Loading label="Loading connections…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : connections.length === 0 ? (
        <Empty icon={<Landmark className="h-5 w-5" />} title="No ledger connected" text="Connect QuickBooks or Xero above, or start with the simulated ledger to see exactly what would be sent." />
      ) : (
        <>
          {connections.length > 1 && current && (
            <Tabs
              id="acct-conn"
              label="Connections"
              className="mb-3"
              tabs={connections.map((c) => ({ id: c.id, label: `${providerLabel(c.provider)}${c.company_name ? ` · ${c.company_name}` : ""}` }))}
              value={current.id}
              onChange={setSelected}
            />
          )}
          {current && (
            <TabPanel id="acct-conn" value={current.id}>
              <ConnectionPanel
                key={current.id}
                c={current}
                busy={busy}
                onSync={() => void syncNow(current)}
                onDisconnect={() => setDisconnect(current)}
                onNotice={setNotice}
                onChanged={load}
              />
            </TabPanel>
          )}
        </>
      )}

      {disconnect && (
        <Dialog title={`Disconnect ${providerLabel(disconnect.provider)}?`} description="Sync links and the log for this connection are removed. Invoices, payments and expenses already in the ledger stay there; reconnecting may create duplicates." onClose={() => busy === null && setDisconnect(null)} size="sm">
          <DialogFooter>
            <Button variant="ghost" touch onClick={() => setDisconnect(null)} disabled={busy !== null}>Cancel</Button>
            <Button variant="destructive" touch onClick={() => void confirmDisconnect()} disabled={busy !== null}>
              {busy === `del:${disconnect.id}` && spinner}
              Disconnect
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </PageContainer>
  );
}

function providerLabel(id: LiveAccountingProviderId): string {
  return id === "quickbooks" ? "QuickBooks Online" : id === "xero" ? "Xero" : "Simulated ledger";
}

function ProviderCard({ p, connected, disabled }: { p: LiveProviderInfo; connected: AccountingConnectionView[]; disabled: boolean }) {
  return (
    <div className="flex flex-col justify-between gap-3 rounded-xl border border-border bg-card p-4">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{p.label}</h3>
          <Pill tone={p.configured ? (connected.length ? "success" : "info") : "neutral"}>{connected.length ? `${connected.length} connected` : p.configured ? "Ready" : "Not configured"}</Pill>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {p.id === "simulated" ? "An in-app ledger that records every payload instead of sending it. Safe for demos and tests." : p.reason ?? `Live two-way sync with ${p.label}.`}
        </p>
        {p.env.length > 0 && !p.configured && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Env: {p.env.map((e) => <code key={e} className="mr-1 rounded bg-secondary px-1">{e}</code>)}
          </p>
        )}
      </div>
      <Button asChild={p.configured && !disabled} variant={connected.length ? "outline" : "default"} size="sm" touch disabled={!p.configured || disabled}>
        {p.configured && !disabled ? <a href={`/api/accounting/connect/${p.id}`}>{connected.length ? "Connect another" : "Connect"}</a> : <span>Connect</span>}
      </Button>
    </div>
  );
}

function ConnectionPanel({ c, busy, onSync, onDisconnect, onNotice, onChanged }: {
  c: AccountingConnectionView; busy: string | null; onSync: () => void; onDisconnect: () => void; onNotice: (n: Notice | null) => void; onChanged: () => Promise<void>;
}) {
  const nextSignal = useAbortable();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [settings, setSettings] = useState<AccountingSettings>(c.settings);
  const [saving, setSaving] = useState(false);

  const loadDetail = useCallback(async () => {
    const signal = nextSignal();
    setDetailError(null);
    try {
      const res = await fetch(`/api/accounting/connections/${encodeURIComponent(c.id)}`, { signal });
      if (!res.ok) throw new Error(await readError(res, "Could not load connection"));
      const d = (await res.json()) as Detail;
      setDetail(d);
      setSettings(d.connection.settings);
    } catch (err) {
      if (isAbortError(err)) return;
      setDetailError(err instanceof Error ? err.message : "Could not load connection.");
    }
  }, [c.id, nextSignal]);
  useEffect(() => { void loadDetail(); }, [loadDetail, c.last_sync_at]);

  async function save() {
    setSaving(true);
    onNotice(null);
    try {
      const res = await fetch(`/api/accounting/connections/${encodeURIComponent(c.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings }) });
      if (!res.ok) throw new Error(await readError(res, "Could not save"));
      onNotice({ tone: "success", text: "Account mappings saved." });
      await onChanged();
    } catch (err) {
      onNotice({ tone: "error", text: err instanceof Error ? err.message : "Could not save." });
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled() {
    setSaving(true);
    try {
      const res = await fetch(`/api/accounting/connections/${encodeURIComponent(c.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: c.status === "disabled" ? "connected" : "disabled" }) });
      if (!res.ok) throw new Error(await readError(res, "Could not update"));
      await onChanged();
    } catch (err) {
      onNotice({ tone: "error", text: err instanceof Error ? err.message : "Could not update." });
    } finally {
      setSaving(false);
    }
  }

  const accounts = detail?.accounts ?? [];
  const byType = (t: string) => accounts.filter((a) => a.type === t);
  const syncing = busy === `sync:${c.id}`;

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="break-words text-base font-semibold">{c.company_name ?? providerLabel(c.provider)}</h2>
              <Pill tone={STATUS_TONE[c.status] ?? "neutral"}>{cap(c.status)}</Pill>
            </div>
            <p className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {providerLabel(c.provider)}{c.realm_id ? ` · company ${c.realm_id}` : ""}{c.tenant_id ? ` · tenant ${c.tenant_id.slice(0, 8)}…` : ""} · last sync {c.last_sync_at ? timeAgo(c.last_sync_at) : "never"} · {c.counts.linked} linked{c.counts.errors ? `, ${c.counts.errors} with errors` : ""}
            </p>
            {c.last_error && <p className="mt-2 text-xs text-red-700 dark:text-red-300 [overflow-wrap:anywhere]">{c.last_error}</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" touch onClick={onSync} disabled={busy !== null || c.status === "disabled"}>
              {syncing ? spinner : <RefreshCw className="h-3.5 w-3.5" aria-hidden />} Sync now
            </Button>
            <Button size="sm" variant="outline" touch onClick={() => void toggleEnabled()} disabled={saving || busy !== null}>
              {c.status === "disabled" ? "Enable" : "Pause"}
            </Button>
            <Button size="sm" variant="ghost" touch onClick={onDisconnect} disabled={busy !== null}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden /> Disconnect
            </Button>
          </div>
        </div>
      </section>

      <section aria-labelledby="mappings-heading" className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <h2 id="mappings-heading" className="text-sm font-semibold">Account mappings</h2>
        <p className="mt-1 text-xs text-muted-foreground">Where each kind of record lands in the ledger. Pulled from the chart of accounts{detail ? ` (${accounts.length} accounts)` : ""}.</p>
        {detailError && <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-300 [overflow-wrap:anywhere]">{detailError}</p>}
        {detail?.accountsError && <Banner tone="warn" className="mt-3">Could not load the chart of accounts: {detail.accountsError}</Banner>}
        {!detail && !detailError ? (
          <Loading label="Loading accounts…" className="mt-3" />
        ) : (
          <form className="mt-4 grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <AccountSelect label="Sales / income account" hint="Invoice lines without a linked item." value={settings.sales_account_id} options={byType("income")} onChange={(v) => setSettings((s) => ({ ...s, sales_account_id: v }))} />
            <AccountSelect label="Expense account" hint="Expenses are booked here." value={settings.expense_account_id} options={byType("expense")} onChange={(v) => setSettings((s) => ({ ...s, expense_account_id: v }))} />
            <AccountSelect label="Bank / deposit account" hint="Payments are deposited here; expenses are paid from it." value={settings.deposit_account_id} options={byType("bank")} onChange={(v) => setSettings((s) => ({ ...s, deposit_account_id: v }))} />
            <AccountSelect label="Tax code (taxed lines)" value={settings.tax_code_id} options={byType("tax")} onChange={(v) => setSettings((s) => ({ ...s, tax_code_id: v }))} allowCustom />
            <AccountSelect label="Tax code (zero-rated lines)" value={settings.zero_tax_code_id} options={byType("tax")} onChange={(v) => setSettings((s) => ({ ...s, zero_tax_code_id: v }))} allowCustom />
            <div className="flex flex-col justify-end gap-2">
              <Checkbox label="Push payments" checked={settings.push_payments !== false} onChange={(e) => setSettings((s) => ({ ...s, push_payments: e.target.checked }))} />
              <Checkbox label="Push expenses" checked={settings.push_expenses !== false} onChange={(e) => setSettings((s) => ({ ...s, push_expenses: e.target.checked }))} />
            </div>
            <div className="sm:col-span-2">
              <Button type="submit" size="sm" touch disabled={saving}>{saving && spinner} Save mappings</Button>
            </div>
          </form>
        )}
      </section>

      <PushNow connectionId={c.id} disabled={busy !== null || c.status === "disabled"} onNotice={onNotice} onChanged={onChanged} />

      <SyncLog connectionId={c.id} refreshKey={c.last_sync_at ?? ""} />

      {c.provider === "simulated" && detail && <SimulatedObjects objects={detail.simulated} />}
    </div>
  );
}

function AccountSelect({ label, hint, value, options, onChange, allowCustom }: { label: string; hint?: string; value: string | null | undefined; options: AccountOption[]; onChange: (v: string | null) => void; allowCustom?: boolean }) {
  const known = options.some((o) => o.id === value);
  if (options.length === 0 && allowCustom) {
    return (
      <Field label={label} hint={hint ?? "Type the code your ledger uses."}>
        <Input value={value ?? ""} onChange={(e) => onChange(e.target.value.trim() || null)} placeholder="e.g. TAX" />
      </Field>
    );
  }
  return (
    <Field label={label} hint={hint}>
      <Select value={known ? (value ?? "") : value ? "__custom" : ""} onChange={(e) => onChange(e.target.value === "__custom" ? value ?? null : e.target.value || null)}>
        <option value="">— not mapped —</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>{o.code ? `${o.code} · ` : ""}{o.name}</option>
        ))}
        {!known && value && <option value="__custom">Custom: {value}</option>}
      </Select>
    </Field>
  );
}

function PushNow({ connectionId, disabled, onNotice, onChanged }: { connectionId: string; disabled: boolean; onNotice: (n: Notice | null) => void; onChanged: () => Promise<void> }) {
  const [kind, setKind] = useState<AccountingEntityKind>("invoice");
  const [id, setId] = useState("");
  const [busy, setBusy] = useState(false);
  async function push(e: React.FormEvent) {
    e.preventDefault();
    if (!id.trim()) return;
    setBusy(true);
    onNotice(null);
    try {
      const res = await fetch("/api/accounting/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, id: id.trim(), connection_id: connectionId, force: kind === "invoice" }) });
      const d = (await res.json().catch(() => null)) as { results?: Array<{ status: string; remoteId?: string | null; message?: string }>; error?: string } | null;
      const r = d?.results?.[0];
      if (!res.ok && !r) throw new Error(d?.error ?? `Push failed (${res.status})`);
      onNotice(r?.status === "ok" ? { tone: "success", text: `Pushed ${kind} ${id.trim()} → ${r.remoteId}.` } : r?.status === "skipped" ? { tone: "info", text: `Skipped: ${r.message}` } : { tone: "error", text: r?.message ?? "Push failed." });
      await onChanged();
    } catch (err) {
      onNotice({ tone: "error", text: err instanceof Error ? err.message : "Push failed." });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="push-heading" className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <h2 id="push-heading" className="text-sm font-semibold">Push now</h2>
      <p className="mt-1 text-xs text-muted-foreground">Send one record immediately (its customer and invoice go first when needed). Paste the id from Billing, Finance, CRM or Inventory.</p>
      <form className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(e) => void push(e)}>
        <Field label="Kind" className="sm:w-40">
          <Select value={kind} onChange={(e) => setKind(e.target.value as AccountingEntityKind)}>
            {KINDS.map((k) => <option key={k} value={k}>{cap(k)}</option>)}
          </Select>
        </Field>
        <Field label="Record id" className="flex-1">
          <Input value={id} onChange={(e) => setId(e.target.value)} placeholder="uuid" required />
        </Field>
        <Button type="submit" size="sm" touch disabled={disabled || busy || !id.trim()}>{busy ? spinner : <Send className="h-3.5 w-3.5" aria-hidden />} Push</Button>
      </form>
    </section>
  );
}

function SyncLog({ connectionId, refreshKey }: { connectionId: string; refreshKey: string }) {
  const nextSignal = useAbortable();
  const [entries, setEntries] = useState<AccountingSyncLogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [direction, setDirection] = useState("");
  const [kind, setKind] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    const signal = nextSignal();
    setError(null);
    try {
      const q = new URLSearchParams({ limit: "100" });
      if (status) q.set("status", status);
      if (direction) q.set("direction", direction);
      if (kind) q.set("kind", kind);
      const res = await fetch(`/api/accounting/connections/${encodeURIComponent(connectionId)}/log?${q}`, { signal });
      if (!res.ok) throw new Error(await readError(res, "Could not load log"));
      setEntries(((await res.json()) as { entries: AccountingSyncLogRow[] }).entries);
    } catch (err) {
      if (isAbortError(err)) return;
      setError(err instanceof Error ? err.message : "Could not load log.");
    }
  }, [connectionId, status, direction, kind, nextSignal]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const counts = useMemo(() => ({ errors: entries?.filter((e) => e.status === "error").length ?? 0 }), [entries]);

  return (
    <section aria-labelledby="log-heading" className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 id="log-heading" className="text-sm font-semibold">Sync log</h2>
          <p className="mt-1 text-xs text-muted-foreground">Latest 100 entries{counts.errors ? ` · ${counts.errors} error(s) shown` : ""}. Select a row to expand its message.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
            <option value="">All statuses</option><option value="ok">OK</option><option value="error">Error</option><option value="skipped">Skipped</option>
          </Select>
          <Select aria-label="Filter by direction" value={direction} onChange={(e) => setDirection(e.target.value)} className="w-auto">
            <option value="">Push + pull</option><option value="push">Push</option><option value="pull">Pull</option>
          </Select>
          <Select aria-label="Filter by kind" value={kind} onChange={(e) => setKind(e.target.value)} className="w-auto">
            <option value="">All kinds</option>{KINDS.map((k) => <option key={k} value={k}>{cap(k)}</option>)}
          </Select>
          <Button size="sm" variant="outline" touch onClick={() => void load()} aria-label="Refresh log"><RefreshCw className="h-3.5 w-3.5" aria-hidden /></Button>
        </div>
      </div>
      <div className="mt-3">
        {error ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : entries === null ? (
          <Loading label="Loading log…" />
        ) : entries.length === 0 ? (
          <Empty title="Nothing synced yet" text="Run Sync now or push a record to see activity here." />
        ) : (
          <TableScroller label="Sync log">
            <table className="w-full min-w-[640px] text-sm">
              <thead className={THEAD}>
                <tr><th className={TH}>When</th><th className={TH}>Dir</th><th className={TH}>Kind</th><th className={TH}>Status</th><th className={TH}>Record</th><th className={TH}>Remote id</th><th className={TH}>Message</th></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {entries.map((e) => {
                  const expanded = open === e.id;
                  const long = (e.message?.length ?? 0) > 60;
                  return (
                    <tr key={e.id} className={cn("align-top", e.status === "error" && "bg-red-500/5")}>
                      <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground" title={fmt(e.created_at)}>{timeAgo(e.created_at)}</td>
                      <td className="px-3 py-2 text-xs">{cap(e.direction)}</td>
                      <td className="px-3 py-2 text-xs">{e.entity_kind ? cap(e.entity_kind) : "—"}</td>
                      <td className="px-3 py-2"><Pill tone={LOG_TONE[e.status] ?? "neutral"}>{e.status === "ok" ? "OK" : cap(e.status)}</Pill></td>
                      <td className="px-3 py-2 font-mono text-[11px]" title={e.entity_id ?? undefined}>{e.entity_id ? e.entity_id.slice(0, 8) : "—"}</td>
                      <td className="break-all px-3 py-2 font-mono text-[11px]">{e.remote_id ?? "—"}</td>
                      <td className="px-3 py-2 text-xs">
                        {long ? (
                          <button type="button" className="flex min-h-11 items-start gap-1 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0" aria-expanded={expanded} aria-label={expanded ? "Collapse message" : "Expand message"} onClick={() => setOpen(expanded ? null : e.id)}>
                            {expanded ? <ChevronDown className="mt-0.5 h-3 w-3 shrink-0" aria-hidden /> : <ChevronRight className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />}
                            <span className={cn("[overflow-wrap:anywhere]", !expanded && "line-clamp-1")}>{e.message}</span>
                          </button>
                        ) : (
                          <span className="[overflow-wrap:anywhere]">{e.message ?? "—"}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroller>
        )}
      </div>
    </section>
  );
}

function SimulatedObjects({ objects }: { objects: Detail["simulated"] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section aria-labelledby="sim-heading" className="rounded-xl border border-dashed border-border bg-card p-4 sm:p-5">
      <h2 id="sim-heading" className="text-sm font-semibold">What would be sent</h2>
      <p className="mt-1 text-xs text-muted-foreground">The simulated ledger stores each payload instead of posting it. Payloads use the QuickBooks shape.</p>
      {objects.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">Nothing pushed yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-border">
          {objects.map((o) => (
            <li key={o.id} className="py-2">
              <button type="button" className="flex min-h-11 w-full items-center justify-between gap-2 rounded text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0" aria-expanded={open === o.id} aria-label={`${open === o.id ? "Collapse" : "Expand"} ${o.kind} ${o.remote_id}`} onClick={() => setOpen(open === o.id ? null : o.id)}>
                <span className="flex min-w-0 flex-wrap items-center gap-2"><Pill tone={o.source === "remote" ? "violet" : "info"}>{cap(o.kind)}</Pill><code className="break-all">{o.remote_id}</code></span>
                <span className="shrink-0 text-muted-foreground">{timeAgo(o.updated_at)}</span>
              </button>
              {open === o.id && <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-secondary/50 p-3 text-[11px]">{JSON.stringify(o.payload, null, 2)}</pre>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
