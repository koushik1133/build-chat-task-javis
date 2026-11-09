"use client";

import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { api, Banner, Empty, Field } from "@/components/finance/shared";
import { US_STATES } from "@/lib/tax-compliance/validators";
import type { Exemption } from "./types";

interface C { id: string; full_name: string }

export function ExemptionsTab({ rows, onChanged }: { rows: Exemption[]; onChanged: () => void }) {
  const [contacts, setContacts] = useState<C[]>([]);
  const [f, setF] = useState({ contact_id: "", jurisdiction: "CA", certificate_ref: "", expires_at: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ contacts: C[] }>("/api/crm/contacts").then((r) => setContacts((r.contacts ?? []).slice(0, 200))).catch(() => undefined);
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/tax/exemptions", { method: "POST", body: JSON.stringify({ contact_id: f.contact_id, jurisdiction: f.jurisdiction, certificate_ref: f.certificate_ref || null, expires_at: f.expires_at ? new Date(f.expires_at).toISOString() : null }) });
      setF((p) => ({ ...p, certificate_ref: "", expires_at: "" }));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    try {
      await api(`/api/tax/exemptions?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete.");
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">US exemption certificates: sales to a contact in the listed state are not taxed while the certificate is unexpired.</p>
      <form onSubmit={add} className="grid gap-3 sm:grid-cols-5 sm:items-end">
        <Field label="Contact" required>
          <Select required value={f.contact_id} onChange={(e) => setF({ ...f, contact_id: e.target.value })}>
            <option value="">Select</option>
            {contacts.map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}
          </Select>
        </Field>
        <Field label="State">
          <Select value={f.jurisdiction} onChange={(e) => setF({ ...f, jurisdiction: e.target.value })}>
            <option value="ALL">All</option>
            {Object.keys(US_STATES).map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
        </Field>
        <Field label="Certificate ref"><Input maxLength={120} value={f.certificate_ref} onChange={(e) => setF({ ...f, certificate_ref: e.target.value })} /></Field>
        <Field label="Expires"><Input type="date" value={f.expires_at} onChange={(e) => setF({ ...f, expires_at: e.target.value })} /></Field>
        <Button type="submit" touch disabled={busy || !f.contact_id}>Add certificate</Button>
      </form>
      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}
      {rows.length === 0 ? <Empty title="No certificates" text="Add one to exempt a customer in a state." /> : (
        <TableScroller label="Exemption certificates">
          <table className="w-full text-sm">
            <thead className={THEAD}><tr><th scope="col" className={TH}>Contact</th><th scope="col" className={TH}>State</th><th scope="col" className={TH}>Certificate</th><th scope="col" className={TH}>Expires</th><th scope="col" className={TH}><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-3 py-2">{r.contact_name ?? r.contact_id}</td>
                  <td className="px-3 py-2">{r.jurisdiction}</td>
                  <td className="px-3 py-2">{r.certificate_ref ?? ""}</td>
                  <td className="px-3 py-2">{r.expires_at ? r.expires_at.slice(0, 10) : "Never"}</td>
                  <td className="px-3 py-2"><Button type="button" size="icon" variant="ghost" aria-label={`Delete certificate for ${r.contact_name ?? "contact"}`} onClick={() => void remove(r.id)}><Trash2 className="h-4 w-4" aria-hidden /></Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      )}
    </div>
  );
}
