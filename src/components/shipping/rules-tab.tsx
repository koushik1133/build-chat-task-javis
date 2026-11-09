"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { Banner, Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { api, fromMinor, toMinor } from "@/components/finance/shared";
import { fmtMoney } from "@/lib/money/format";
import { RULE_KINDS, evaluateRules, type RuleKind, type ShippingRule } from "@/lib/shipping/rules";

type Notice = { tone: "success" | "error"; text: string };
const KIND_LABEL: Record<RuleKind, string> = { flat: "Flat rate", weight_tiers: "Weight tiers", free_over: "Free over amount", carrier_calculated: "Carrier calculated" };

interface Draft { id: string | null; name: string; kind: RuleKind; countries: string; active: boolean; price: string; threshold: string; tiers: string; markup: string }
const blank = (): Draft => ({ id: null, name: "", kind: "flat", countries: "", active: true, price: "5.00", threshold: "50.00", tiers: "500:4.00, 2000:7.00", markup: "0" });

function toConfig(d: Draft): Record<string, unknown> {
  if (d.kind === "flat") return { price_minor: toMinor(d.price) };
  if (d.kind === "free_over") return { threshold_minor: toMinor(d.threshold) };
  if (d.kind === "carrier_calculated") return { markup_pct: Number(d.markup) || 0 };
  const tiers = d.tiers.split(",").map((t) => t.trim().split(":")).filter((p) => p.length === 2).map(([g, p]) => ({ up_to_grams: Math.round(Number(g)), price_minor: toMinor(p) }));
  return { tiers, over_price_minor: tiers.length ? Math.max(...tiers.map((t) => t.price_minor)) : 0 };
}
function fromRule(r: ShippingRule): Draft {
  const c = r.config;
  const tiers = Array.isArray(c.tiers) ? (c.tiers as Array<{ up_to_grams: number; price_minor: number }>).map((t) => `${t.up_to_grams}:${fromMinor(t.price_minor)}`).join(", ") : "";
  return { id: r.id, name: r.name, kind: r.kind, countries: r.countries.join(", "), active: r.active, price: fromMinor(Number(c.price_minor) || 0), threshold: fromMinor(Number(c.threshold_minor) || 0), tiers, markup: String(c.markup_pct ?? 0) };
}

export function RulesTab({ notify }: { notify: (n: Notice) => void }) {
  const [rules, setRules] = useState<ShippingRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [sample, setSample] = useState({ country: "US", subtotal: "40.00", weight: "800" });
  const [settings, setSettings] = useState<{ return_window_days: number; shipping_tax_bp: number } | null>(null);

  const load = useCallback(async () => {
    try {
      setRules((await api<{ rules: ShippingRule[] }>("/api/shipping/rules")).rules);
      setSettings(await api("/api/shipping/settings"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load rules");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const preview = useMemo(() => evaluateRules(rules ?? [], { country: sample.country, subtotal_minor: toMinor(sample.subtotal), weight_grams: Number(sample.weight) || 0 }), [rules, sample]);

  async function save() {
    if (!draft) return;
    setBusy(true);
    try {
      const body = JSON.stringify({ name: draft.name, kind: draft.kind, config: toConfig(draft), countries: draft.countries.split(",").map((c) => c.trim()).filter(Boolean), active: draft.active, sort: 0 });
      await api(draft.id ? `/api/shipping/rules/${draft.id}` : "/api/shipping/rules", { method: draft.id ? "PUT" : "POST", body });
      setDraft(null);
      notify({ tone: "success", text: "Rule saved." });
      await load();
    } catch (e) {
      notify({ tone: "error", text: e instanceof Error ? e.message : "Could not save the rule" });
    } finally {
      setBusy(false);
    }
  }
  async function remove(r: ShippingRule) {
    if (!(await confirmDialog({ title: `Delete "${r.name}"?`, body: "Customers stop seeing this option at checkout.", confirmLabel: "Delete", tone: "danger" }))) return;
    await api(`/api/shipping/rules/${r.id}`, { method: "DELETE" }).then(load).catch((e: unknown) => notify({ tone: "error", text: e instanceof Error ? e.message : "Could not delete" }));
  }
  async function saveSettings(patch: Partial<{ return_window_days: number; shipping_tax_bp: number }>) {
    try {
      setSettings(await api("/api/shipping/settings", { method: "PUT", body: JSON.stringify(patch) }));
      notify({ tone: "success", text: "Saved." });
    } catch (e) {
      notify({ tone: "error", text: e instanceof Error ? e.message : "Could not save" });
    }
  }

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!rules) return <Loading label="Loading rules…" />;
  return (
    <div className="space-y-6">
      <Banner tone="info">With no active rules, checkout keeps using the flat shipping charge and pickup option from your storefront settings.</Banner>
      <section className="space-y-3" aria-label="Shipping rules">
        <div className="flex items-center justify-between"><h2 className="text-sm font-semibold">Rules</h2><Button type="button" size="sm" touch onClick={() => setDraft(blank())}><Plus className="mr-1.5 h-4 w-4" aria-hidden />Add rule</Button></div>
        {rules.length === 0 ? <Empty title="No shipping rules" text="Add a flat rate, weight tiers, a free-shipping threshold or live carrier rates." /> : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {rules.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                <button type="button" onClick={() => setDraft(fromRule(r))} className="min-h-11 rounded text-left font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0">{r.name}</button>
                <span className="text-muted-foreground">{KIND_LABEL[r.kind]}{r.countries.length ? ` · ${r.countries.join(", ")}` : " · everywhere"}{r.active ? "" : " · off"}</span>
                <Button type="button" variant="ghost" size="sm" className="ml-auto" aria-label={`Delete rule ${r.name}`} onClick={() => void remove(r)}><Trash2 className="h-4 w-4" aria-hidden /></Button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {draft && (
        <section className="space-y-3 rounded-lg border border-border p-4" aria-label="Edit rule">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" required><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={120} /></Field>
            <Field label="Type"><Select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as RuleKind })}>{RULE_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</Select></Field>
            {draft.kind === "flat" && <Field label="Price"><Input inputMode="decimal" value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} /></Field>}
            {draft.kind === "free_over" && <Field label="Free when subtotal is at least"><Input inputMode="decimal" value={draft.threshold} onChange={(e) => setDraft({ ...draft, threshold: e.target.value })} /></Field>}
            {draft.kind === "weight_tiers" && <Field label="Tiers (grams:price, ...)" hint="Example: 500:4.00, 2000:7.00"><Input value={draft.tiers} onChange={(e) => setDraft({ ...draft, tiers: e.target.value })} /></Field>}
            {draft.kind === "carrier_calculated" && <Field label="Markup %" hint="Added on top of the carrier rate."><Input inputMode="decimal" value={draft.markup} onChange={(e) => setDraft({ ...draft, markup: e.target.value })} /></Field>}
            <Field label="Countries" hint="Comma separated, e.g. US, CA. Empty = everywhere."><Input value={draft.countries} onChange={(e) => setDraft({ ...draft, countries: e.target.value })} /></Field>
            <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} className="h-4 w-4 accent-primary" />Active</label>
          </div>
          <div className="flex gap-2"><Button type="button" touch onClick={() => void save()} disabled={busy || !draft.name.trim()} aria-busy={busy || undefined}>{busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : null}Save rule</Button><Button type="button" variant="outline" touch onClick={() => setDraft(null)}>Cancel</Button></div>
        </section>
      )}
      <section className="rounded-lg border border-border p-4" aria-label="Preview">
        <h2 className="mb-2 text-sm font-semibold">Preview a sample cart</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Country"><Input value={sample.country} onChange={(e) => setSample({ ...sample, country: e.target.value })} /></Field>
          <Field label="Subtotal"><Input inputMode="decimal" value={sample.subtotal} onChange={(e) => setSample({ ...sample, subtotal: e.target.value })} /></Field>
          <Field label="Weight (g)"><Input inputMode="numeric" value={sample.weight} onChange={(e) => setSample({ ...sample, weight: e.target.value })} /></Field>
        </div>
        <ul className="mt-3 space-y-1 text-sm" aria-live="polite">
          {preview.length === 0 ? <li className="text-muted-foreground">No option would be offered.</li> : preview.map((o) => <li key={o.id} className="flex justify-between gap-3"><span>{o.label}</span><span className="tabular-nums">{o.needs_carrier ? "live carrier rate" : fmtMoney(o.price_minor, "USD")}</span></li>)}
        </ul>
      </section>
      {settings && (
        <section className="grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-2" aria-label="Returns and tax">
          <Field label="Return window (days)" hint="From delivery."><Input inputMode="numeric" defaultValue={settings.return_window_days} onBlur={(e) => { const v = Number(e.target.value); if (Number.isInteger(v) && v !== settings.return_window_days) void saveSettings({ return_window_days: v }); }} /></Field>
          <Field label="Tax on shipping (basis points)" hint="0 = untaxed; 2000 = 20%."><Input inputMode="numeric" defaultValue={settings.shipping_tax_bp} onBlur={(e) => { const v = Number(e.target.value); if (Number.isInteger(v) && v !== settings.shipping_tax_bp) void saveSettings({ shipping_tax_bp: v }); }} /></Field>
        </section>
      )}
    </div>
  );
}
