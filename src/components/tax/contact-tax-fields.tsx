"use client";

import { useEffect, useState } from "react";
import { Input, Select } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { api, Field } from "@/components/finance/shared";
import { validateEuVat, validateGstin, validateUkVat } from "@/lib/tax-compliance/validators";

/** Additive tax-registration fields for an existing CRM contact (saved on their own). */
export function ContactTaxFields({ contactId }: { contactId: string }) {
  const [f, setF] = useState({ tax_number: "", tax_country: "", tax_state: "", tax_registration_type: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ fields: { tax_number: string | null; tax_country: string | null; tax_state: string | null; tax_registration_type: string | null } }>(`/api/tax/contact/${contactId}`)
      .then((r) => setF({ tax_number: r.fields.tax_number ?? "", tax_country: r.fields.tax_country ?? "", tax_state: r.fields.tax_state ?? "", tax_registration_type: r.fields.tax_registration_type ?? "" }))
      .catch(() => undefined);
  }, [contactId]);
  const id = f.tax_number.trim();
  const hint = !id ? null : validateGstin(id).valid ? "Valid GSTIN" : validateEuVat(id).valid ? "Valid EU VAT format" : validateUkVat(id).valid ? "Valid UK VAT" : "Not a recognised GSTIN / VAT format";
  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      await api(`/api/tax/contact/${contactId}`, { method: "PUT", body: JSON.stringify({ tax_number: id || null, tax_country: f.tax_country || null, tax_state: f.tax_state || null, tax_registration_type: f.tax_registration_type || null }) });
      setMsg("Tax details saved.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <fieldset className="space-y-2 rounded-lg border border-border p-3">
      <legend className="px-1 text-xs font-medium text-muted-foreground">Tax registration</legend>
      <div className="grid grid-cols-2 gap-2">
        <Field label="GSTIN / VAT ID" hint={hint ?? undefined}><Input maxLength={40} value={f.tax_number} onChange={(e) => setF({ ...f, tax_number: e.target.value })} spellCheck={false} /></Field>
        <Field label="Type">
          <Select value={f.tax_registration_type} onChange={(e) => setF({ ...f, tax_registration_type: e.target.value })}>
            <option value="">Not set</option><option value="b2b">Business (B2B)</option><option value="b2c">Consumer (B2C)</option><option value="exempt">Exempt</option>
          </Select>
        </Field>
        <Field label="Country (ISO)"><Input maxLength={2} value={f.tax_country} onChange={(e) => setF({ ...f, tax_country: e.target.value.toUpperCase() })} /></Field>
        <Field label="State"><Input maxLength={60} value={f.tax_state} onChange={(e) => setF({ ...f, tax_state: e.target.value })} /></Field>
      </div>
      <div className="flex items-center gap-3">
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void save()}>Save tax details</Button>
        {msg && <span role="status" className="text-xs text-muted-foreground">{msg}</span>}
      </div>
    </fieldset>
  );
}
