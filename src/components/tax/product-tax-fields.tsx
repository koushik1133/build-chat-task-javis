"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { api, Field } from "@/components/finance/shared";

/** HSN/SAC + tax category for an existing product (saved on its own). */
export function ProductTaxFields({ productId }: { productId: string }) {
  const [hsn, setHsn] = useState("");
  const [cat, setCat] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    api<{ fields: { hsn_sac_code: string | null; tax_category: string | null } }>(`/api/tax/product/${productId}`)
      .then((r) => { setHsn(r.fields.hsn_sac_code ?? ""); setCat(r.fields.tax_category ?? ""); })
      .catch(() => undefined);
  }, [productId]);
  async function save() {
    setMsg(null);
    try {
      await api(`/api/tax/product/${productId}`, { method: "PUT", body: JSON.stringify({ hsn_sac_code: hsn.trim() || null, tax_category: cat.trim() || null }) });
      setMsg("Saved.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not save.");
    }
  }
  return (
    <fieldset className="rounded-lg border border-border p-3">
      <legend className="px-1 text-sm font-medium">Tax compliance</legend>
      <div className="grid gap-3 sm:grid-cols-3 sm:items-end">
        <Field label="HSN / SAC code" hint="4-8 digits (India GST)"><Input inputMode="numeric" maxLength={8} value={hsn} onChange={(e) => setHsn(e.target.value)} autoComplete="off" /></Field>
        <Field label="Tax category"><Input maxLength={60} value={cat} onChange={(e) => setCat(e.target.value)} autoComplete="off" /></Field>
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => void save()}>Save tax fields</Button>
          {msg && <span role="status" className="text-xs text-muted-foreground">{msg}</span>}
        </div>
      </div>
    </fieldset>
  );
}
