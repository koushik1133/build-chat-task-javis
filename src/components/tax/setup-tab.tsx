"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Select } from "@/components/ui/input";
import { api, Banner, Field } from "@/components/finance/shared";
import { FILING_FREQUENCIES, REGIMES, REGIME_INFO, REGISTRATION_TYPES, VERIFY_NOTICE, type ProfileSettings, type Regime } from "@/lib/tax-compliance/regimes";
import { validateTaxId } from "@/lib/tax-compliance/validators";
import { SPIN, type TaxProfile } from "./types";

export function SetupTab({ profile, onSaved }: { profile: TaxProfile | null; onSaved: (p: TaxProfile) => void }) {
  const [regime, setRegime] = useState<Regime>(profile?.regime ?? "generic");
  const [country, setCountry] = useState(profile?.country ?? "");
  const [state, setState] = useState(profile?.state_province ?? "");
  const [reg, setReg] = useState(profile?.registration_number ?? "");
  const [regType, setRegType] = useState(profile?.registration_type ?? "regular");
  const [freq, setFreq] = useState(profile?.filing_frequency ?? "quarterly");
  const [einv, setEinv] = useState(profile?.e_invoicing_enabled ?? false);
  const [s, setS] = useState<ProfileSettings>(profile?.settings ?? {});
  const [nexus, setNexus] = useState((profile?.settings.nexus_states ?? []).join(", "));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const info = REGIME_INFO[regime];
  const check = useMemo(() => (reg.trim() && regime !== "generic" ? validateTaxId(regime, reg) : null), [reg, regime]);
  const set = <K extends keyof ProfileSettings>(k: K, v: ProfileSettings[K]) => setS((p) => ({ ...p, [k]: v }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setOk(false);
    try {
      const settings: ProfileSettings = { ...s };
      if (regime === "us_sales") settings.nexus_states = nexus.split(/[ ,]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
      const r = await api<{ profile: TaxProfile }>("/api/tax/profile", {
        method: "PUT",
        body: JSON.stringify({ regime, country: country.trim() || null, state_province: state.trim() || null, registration_number: reg.trim() || null, registration_type: regType, filing_frequency: freq, e_invoicing_enabled: einv, settings }),
      });
      onSaved(r.profile);
      setOk(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <Banner tone="warn">{VERIFY_NOTICE}</Banner>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Tax regime" hint={info.source}>
          <Select value={regime} onChange={(e) => setRegime(e.target.value as Regime)}>
            {REGIMES.map((r) => <option key={r} value={r}>{REGIME_INFO[r].label}</option>)}
          </Select>
        </Field>
        <Field label="Country (ISO code)" hint="e.g. IN, DE, GB, US">
          <Input maxLength={2} value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} autoComplete="off" />
        </Field>
        <Field label={regime === "india_gst" ? "State code" : "State / province"} hint={regime === "india_gst" ? "2 digits, derived from the GSTIN if blank" : undefined}>
          <Input maxLength={60} value={state} onChange={(e) => setState(e.target.value)} autoComplete="off" />
        </Field>
        <div>
          <Field label={info.tax_id_label} error={check && !check.valid ? check.reason : null}>
            <Input value={reg} onChange={(e) => setReg(e.target.value)} spellCheck={false} autoComplete="off" maxLength={40} />
          </Field>
          <p role="status" aria-live="polite" className="mt-1 min-h-5 text-xs">
            {check?.valid && <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Valid format and checksum (not proof of registration)</span>}
            {check && !check.valid && <span className="inline-flex items-center gap-1 text-red-700 dark:text-red-300"><XCircle className="h-3.5 w-3.5" aria-hidden /> Invalid format</span>}
          </p>
        </div>
        <Field label="Registration type">
          <Select value={regType} onChange={(e) => setRegType(e.target.value as typeof regType)}>
            {REGISTRATION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </Select>
        </Field>
        <Field label="Filing frequency" hint="Used for reminders only">
          <Select value={freq} onChange={(e) => setFreq(e.target.value as typeof freq)}>
            {FILING_FREQUENCIES.map((t) => <option key={t} value={t}>{t}</option>)}
          </Select>
        </Field>
      </div>
      {regime !== "generic" && (
        <fieldset className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-3">
          <legend className="px-1 text-sm font-medium">Rules</legend>
          {regime !== "us_sales" && (
            <Field label="Supplies are mostly">
              <Select value={s.supply_kind ?? (regime === "india_gst" ? "goods" : "services")} onChange={(e) => set("supply_kind", e.target.value as "goods" | "services")}>
                <option value="goods">Goods</option>
                <option value="services">Services</option>
              </Select>
            </Field>
          )}
          {regime === "india_gst" && (
            <>
              <Field label="HSN digits" hint="Verify against your turnover">
                <Select value={String(s.hsn_digits ?? 4)} onChange={(e) => set("hsn_digits", Number(e.target.value) as 4 | 6 | 8)}>
                  <option value="4">4</option>
                  <option value="6">6</option>
                  <option value="8">8</option>
                </Select>
              </Field>
              <div className="space-y-2 sm:self-end">
                <Checkbox checked={s.lut_zero_rated === true} onChange={(e) => set("lut_zero_rated", e.target.checked)} label="Zero-rate exports/SEZ under LUT" />
                <Checkbox checked={s.reverse_charge_default === true} onChange={(e) => set("reverse_charge_default", e.target.checked)} label="Reverse charge by default" />
              </div>
            </>
          )}
          {regime === "us_sales" && (
            <>
              <Field label="Nexus states" hint="States where you are registered, e.g. CA, NY" className="sm:col-span-2">
                <Input value={nexus} onChange={(e) => setNexus(e.target.value)} autoComplete="off" />
              </Field>
              <div className="sm:self-end">
                <Checkbox checked={s.allow_estimates === true} onChange={(e) => set("allow_estimates", e.target.checked)} label="Allow simulated ZIP estimates" />
              </div>
            </>
          )}
        </fieldset>
      )}
      {REGIME_INFO[regime].e_invoice_formats.length > 0 && (
        <fieldset className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-2">
          <legend className="px-1 text-sm font-medium">E-invoicing (generation only, no live submission)</legend>
          <div className="sm:col-span-2"><Checkbox checked={einv} onChange={(e) => setEinv(e.target.checked)} label="Enable e-invoice generation" /></div>
          <Field label="Legal name"><Input maxLength={200} value={s.legal_name ?? ""} onChange={(e) => set("legal_name", e.target.value)} /></Field>
          <Field label="Address line"><Input maxLength={200} value={s.address_line1 ?? ""} onChange={(e) => set("address_line1", e.target.value)} /></Field>
          <Field label="City"><Input maxLength={100} value={s.city ?? ""} onChange={(e) => set("city", e.target.value)} /></Field>
          <Field label="Postal / PIN code"><Input maxLength={20} value={s.postal_code ?? ""} onChange={(e) => set("postal_code", e.target.value)} /></Field>
        </fieldset>
      )}
      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}
      {ok && <Banner tone="success" onDismiss={() => setOk(false)}>Tax profile saved. New quotes and invoices use these rules.</Banner>}
      <Button type="submit" touch disabled={saving}>{saving && <Loader2 className={SPIN} aria-hidden />} Save tax profile</Button>
    </form>
  );
}
