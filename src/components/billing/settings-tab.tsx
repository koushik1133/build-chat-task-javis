"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Percent, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { Checkbox, Input, Select } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Banner, Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { isAbortError, useAbortable } from "@/components/ui/hooks";
import { rateLabel, TAX_KINDS } from "@/lib/money/tax";
import type { TaxRateOption } from "./shared";

interface BillingSettings {
  tax_id_label: string | null;
  tax_number: string | null;
  prices_include_tax: boolean;
  tax_rounding: "per_line" | "per_total";
  default_terms_days: number;
  dunning_schedule: number[];
  quote_prefix: string;
  invoice_prefix: string;
  credit_note_prefix: string;
  reporting_currency: string | null;
}
interface FxRate { id: string; base: string; quote: string; rate: string; as_of: string }

const spinner = <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.detail?.formErrors?.[0] ?? data?.detail?.fieldErrors ? Object.values(data.detail.fieldErrors as Record<string, string[]>).flat()[0] : (typeof data?.detail === "string" ? data.detail : null) ?? data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

export function SettingsTab({ onNotice }: { onNotice: (n: { tone: "success" | "info" | "error"; text: string }) => void }) {
  const [settings, setSettings] = useState<BillingSettings | null>(null);
  const [rates, setRates] = useState<TaxRateOption[]>([]);
  const [fx, setFx] = useState<FxRate[]>([]);
  const [canEdit, setCanEdit] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const nextSignal = useAbortable();

  const load = useCallback(async () => {
    const signal = nextSignal();
    setLoading(true);
    setError(null);
    try {
      const [s, r, f] = await Promise.all([
        api<{ settings: BillingSettings; canEdit: boolean }>("/api/billing/settings", { signal }),
        api<{ rates: TaxRateOption[] }>("/api/tax-rates?all=1", { signal }),
        api<{ rates: FxRate[] }>("/api/fx-rates", { signal }),
      ]);
      setSettings(s.settings);
      setCanEdit(s.canEdit);
      setRates(r.rates);
      setFx(f.rates);
    } catch (e) {
      if (isAbortError(e)) return;
      setError(e instanceof Error ? e.message : "Could not load settings.");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [nextSignal]);
  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !settings) return <Loading label="Loading billing settings…" className="rounded-xl border border-border bg-card" />;
  if (error && !settings) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!settings) return null;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <TaxRatesCard rates={rates} canEdit={canEdit} onChanged={() => void load()} onNotice={onNotice} />
      <PreferencesCard settings={settings} canEdit={canEdit} onSaved={(s) => { setSettings(s); onNotice({ tone: "success", text: "Billing settings saved." }); }} />
      <FxCard rates={fx} canEdit={canEdit} onChanged={() => void load()} onNotice={onNotice} />
    </div>
  );
}

function Card({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mb-4 mt-0.5 text-xs text-muted-foreground">{description}</p>
      {children}
    </section>
  );
}

function TaxRatesCard({ rates, canEdit, onChanged, onNotice }: { rates: TaxRateOption[]; canEdit: boolean; onChanged: () => void; onNotice: SettingsTabNotice }) {
  const [name, setName] = useState("");
  const [pct, setPct] = useState("");
  const [kind, setKind] = useState<string>("vat");
  const [jurisdiction, setJurisdiction] = useState("");
  const [compound, setCompound] = useState(false);
  const [isDefault, setIsDefault] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      const rate_bp = Math.round((Number(pct) || 0) * 100);
      await api("/api/tax-rates", { method: "POST", body: JSON.stringify({ name, rate_bp, kind, jurisdiction: jurisdiction || null, compound, is_default: isDefault }) });
      setName(""); setPct(""); setJurisdiction(""); setCompound(false); setIsDefault(false);
      onNotice({ tone: "success", text: `Added tax rate ${name}.` });
      onChanged();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not add rate.");
    } finally {
      setSaving(false);
    }
  }
  async function patch(id: string, body: Record<string, unknown>, msg: string) {
    setBusyId(id);
    try {
      await api(`/api/tax-rates/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      onNotice({ tone: "success", text: msg });
      onChanged();
    } catch (e2) {
      onNotice({ tone: "error", text: e2 instanceof Error ? e2.message : "Update failed." });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card title="Tax rates" description="Pick these per line when creating documents. Compound rates apply on top of the other taxes on a line. Deactivated rates stay on old documents.">
      {rates.length === 0 ? (
        <Empty icon={<Percent className="h-5 w-5" />} title="No tax rates yet" text="Add VAT, GST or sales tax rates; the default one is pre-selected on new lines." className="mb-4" />
      ) : (
        <ul className="mb-4 divide-y divide-border rounded-lg border border-border" aria-label="Tax rates">
          {rates.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm" aria-busy={busyId === r.id || undefined}>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className={r.active ? "font-medium" : "font-medium text-muted-foreground line-through"}>{rateLabel(r)}</span>
                <Pill tone="neutral">{r.kind}</Pill>
                {r.compound && <Pill tone="violet">compound</Pill>}
                {r.is_default && <Pill tone="success">default</Pill>}
                {!r.active && <Pill tone="warning">inactive</Pill>}
              </div>
              {canEdit && (
                <div className="flex items-center gap-1">
                  {r.active && !r.is_default && (
                    <Button size="sm" variant="ghost" touch disabled={busyId === r.id} onClick={() => void patch(r.id, { is_default: true }, `${r.name} is now the default rate.`)}>Make default</Button>
                  )}
                  <Button size="sm" variant="ghost" touch disabled={busyId === r.id} onClick={() => void patch(r.id, { active: !r.active }, r.active ? `Deactivated ${r.name}.` : `Reactivated ${r.name}.`)} aria-label={r.active ? `Deactivate ${r.name}` : `Reactivate ${r.name}`}>
                    {r.active ? <Trash2 className="h-3.5 w-3.5" aria-hidden /> : "Reactivate"}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <form onSubmit={add} className="space-y-3">
          {err && <Banner tone="error" onDismiss={() => setErr(null)}>{err}</Banner>}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_5.5rem_6rem_1fr]">
            <Field label="Name"><Input required maxLength={80} placeholder="VAT" value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Rate %"><Input required type="number" inputMode="decimal" min={0} max={100} step="0.01" value={pct} onChange={(e) => setPct(e.target.value)} /></Field>
            <Field label="Kind">
              <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                {TAX_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </Select>
            </Field>
            <Field label="Jurisdiction" hint="Optional"><Input maxLength={80} placeholder="UK" value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} /></Field>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <Checkbox label="Compound (tax on tax)" checked={compound} onChange={(e) => setCompound(e.target.checked)} />
            <Checkbox label="Default for new lines" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
            <Button type="submit" size="sm" touch disabled={saving} className="ml-auto">{saving ? spinner : <Plus className="h-3.5 w-3.5" aria-hidden />} Add rate</Button>
          </div>
        </form>
      )}
    </Card>
  );
}

type SettingsTabNotice = (n: { tone: "success" | "info" | "error"; text: string }) => void;

function PreferencesCard({ settings, canEdit, onSaved }: { settings: BillingSettings; canEdit: boolean; onSaved: (s: BillingSettings) => void }) {
  const [form, setForm] = useState({
    tax_id_label: settings.tax_id_label ?? "",
    tax_number: settings.tax_number ?? "",
    prices_include_tax: settings.prices_include_tax,
    tax_rounding: settings.tax_rounding,
    default_terms_days: String(settings.default_terms_days),
    dunning_schedule: settings.dunning_schedule.join(", "),
    quote_prefix: settings.quote_prefix,
    invoice_prefix: settings.invoice_prefix,
    credit_note_prefix: settings.credit_note_prefix,
    reporting_currency: settings.reporting_currency ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      const sched = form.dunning_schedule.split(/[,\s]+/).filter(Boolean).map(Number);
      if (sched.some((n) => !Number.isInteger(n))) throw new Error("Reminder days must be whole numbers, e.g. -3, 0, 7, 14, 30");
      const body = {
        tax_id_label: form.tax_id_label.trim() || null,
        tax_number: form.tax_number.trim() || null,
        prices_include_tax: form.prices_include_tax,
        tax_rounding: form.tax_rounding,
        default_terms_days: Number(form.default_terms_days) || 0,
        dunning_schedule: sched.length ? sched : undefined,
        quote_prefix: form.quote_prefix.trim().toUpperCase(),
        invoice_prefix: form.invoice_prefix.trim().toUpperCase(),
        credit_note_prefix: form.credit_note_prefix.trim().toUpperCase(),
        reporting_currency: form.reporting_currency.trim() ? form.reporting_currency.trim().toUpperCase() : null,
      };
      const r = await api<{ settings: BillingSettings }>("/api/billing/settings", { method: "PATCH", body: JSON.stringify(body) });
      onSaved(r.settings);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="Tax ID, numbering & payment terms" description="Your tax registration prints on every document. Prefixes apply to new numbers only. Reminder days are relative to the due date (negative = before).">
      <form onSubmit={save} className="space-y-3">
        {err && <Banner tone="error" onDismiss={() => setErr(null)}>{err}</Banner>}
        <div className="grid grid-cols-2 gap-2">
          <Field label="Tax ID label" hint='e.g. "VAT ID", "GSTIN"'><Input maxLength={40} value={form.tax_id_label} disabled={!canEdit} onChange={(e) => set("tax_id_label", e.target.value)} /></Field>
          <Field label="Tax number"><Input maxLength={64} value={form.tax_number} disabled={!canEdit} onChange={(e) => set("tax_number", e.target.value)} /></Field>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Quote prefix"><Input maxLength={8} value={form.quote_prefix} disabled={!canEdit} onChange={(e) => set("quote_prefix", e.target.value.toUpperCase())} /></Field>
          <Field label="Invoice prefix"><Input maxLength={8} value={form.invoice_prefix} disabled={!canEdit} onChange={(e) => set("invoice_prefix", e.target.value.toUpperCase())} /></Field>
          <Field label="Credit note prefix"><Input maxLength={8} value={form.credit_note_prefix} disabled={!canEdit} onChange={(e) => set("credit_note_prefix", e.target.value.toUpperCase())} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Default payment terms (days)"><Input type="number" min={0} max={365} value={form.default_terms_days} disabled={!canEdit} onChange={(e) => set("default_terms_days", e.target.value)} /></Field>
          <Field label="Reminder schedule (days)" hint="Comma separated"><Input value={form.dunning_schedule} disabled={!canEdit} onChange={(e) => set("dunning_schedule", e.target.value)} /></Field>
          <Field label="Tax rounding">
            <Select value={form.tax_rounding} disabled={!canEdit} onChange={(e) => set("tax_rounding", e.target.value as "per_line" | "per_total")}>
              <option value="per_line">Per line</option>
              <option value="per_total">Per total (per rate)</option>
            </Select>
          </Field>
          <Field label="Reporting currency" hint="Blank = org currency"><Input maxLength={3} autoCapitalize="characters" value={form.reporting_currency} disabled={!canEdit} onChange={(e) => set("reporting_currency", e.target.value.toUpperCase())} /></Field>
        </div>
        <Checkbox label="Prices include tax (tax is backed out of unit prices)" checked={form.prices_include_tax} disabled={!canEdit} onChange={(e) => set("prices_include_tax", e.target.checked)} />
        {canEdit && (
          <div className="flex justify-end">
            <Button type="submit" size="sm" touch disabled={saving}>{saving && spinner} Save settings</Button>
          </div>
        )}
      </form>
    </Card>
  );
}

function FxCard({ rates, canEdit, onChanged, onNotice }: { rates: FxRate[]; canEdit: boolean; onChanged: () => void; onNotice: SettingsTabNotice }) {
  const [base, setBase] = useState("");
  const [quote, setQuote] = useState("");
  const [rate, setRate] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      await api("/api/fx-rates", { method: "POST", body: JSON.stringify({ base, quote, rate }) });
      setBase(""); setQuote(""); setRate("");
      onNotice({ tone: "success", text: "Exchange rate saved." });
      onChanged();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not save rate.");
    } finally {
      setSaving(false);
    }
  }
  async function remove(id: string) {
    try {
      await api(`/api/fx-rates?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      onChanged();
    } catch (e2) {
      onNotice({ tone: "error", text: e2 instanceof Error ? e2.message : "Delete failed." });
    }
  }

  return (
    <Card title="Exchange rates" description="Manual rates used to convert revenue into your reporting currency. 1 base = rate quote; the newest rate per pair wins.">
      {rates.length === 0 ? (
        <p className="mb-3 text-sm text-muted-foreground">No rates yet. Multi-currency totals stay per currency until you add one.</p>
      ) : (
        <ul className="mb-3 divide-y divide-border rounded-lg border border-border text-sm" aria-label="Exchange rates">
          {rates.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2 px-3 py-2">
              <span className="tabular-nums">1 {r.base} = {r.rate} {r.quote} <span className="text-xs text-muted-foreground">· {new Date(r.as_of).toLocaleDateString()}</span></span>
              {canEdit && (
                <Button size="sm" variant="ghost" touch onClick={() => void remove(r.id)} aria-label={`Delete rate ${r.base}/${r.quote}`}>
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <form onSubmit={add} className="space-y-2">
          {err && <Banner tone="error" onDismiss={() => setErr(null)}>{err}</Banner>}
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-[5rem_5rem_1fr_auto] sm:items-end">
            <Field label="Base"><Input required maxLength={3} autoCapitalize="characters" placeholder="EUR" value={base} onChange={(e) => setBase(e.target.value.toUpperCase())} /></Field>
            <Field label="Quote"><Input required maxLength={3} autoCapitalize="characters" placeholder="USD" value={quote} onChange={(e) => setQuote(e.target.value.toUpperCase())} /></Field>
            <Field label="Rate"><Input required inputMode="decimal" placeholder="1.0850" value={rate} onChange={(e) => setRate(e.target.value)} /></Field>
            <Button type="submit" size="sm" touch disabled={saving} className="col-span-3 sm:col-span-1">{saving ? spinner : <Plus className="h-3.5 w-3.5" aria-hidden />} Add</Button>
          </div>
        </form>
      )}
    </Card>
  );
}
