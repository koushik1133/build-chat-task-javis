"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { StatusPill } from "@/components/ui/pill";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { api, Banner, Empty, Field } from "@/components/finance/shared";
import type { EInvoiceRow } from "./types";

interface Inv { id: string; number: string; status: string }

export function EInvoicesTab({ rows, onChanged }: { rows: EInvoiceRow[]; onChanged: () => void }) {
  const [invoices, setInvoices] = useState<Inv[]>([]);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api<{ invoices: Inv[] }>("/api/invoices").then((r) => setInvoices(r.invoices.filter((i) => i.status !== "draft" && i.status !== "void").slice(0, 100))).catch(() => undefined);
  }, []);

  async function call(invoiceId: string, action: "generate" | "submit", format?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await fetch(`/api/invoices/${invoiceId}/e-invoice`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...(format ? { format } : {}) }) });
      const j = (await r.json().catch(() => null)) as { error?: string; errors?: string[] } | null;
      if (!r.ok) throw new Error([j?.error, ...(j?.errors ?? [])].filter(Boolean).join(" - ") || `Failed (${r.status})`);
      setNotice(action === "submit" ? "Simulated submission accepted (no government system was contacted)." : "E-invoice generated.");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed.");
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Banner tone="info">E-invoices are generated locally. Submission is simulated and does not reach any government portal or Peppol network.</Banner>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Field label="Invoice" className="sm:w-72">
          <Select value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Select an invoice</option>
            {invoices.map((i) => <option key={i.id} value={i.id}>{i.number}</option>)}
          </Select>
        </Field>
        <Button type="button" touch disabled={!pick || busy} onClick={() => void call(pick, "generate")}>Generate e-invoice</Button>
      </div>
      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}
      {notice && <Banner tone="success" onDismiss={() => setNotice(null)}>{notice}</Banner>}
      {rows.length === 0 ? <Empty title="No e-invoices yet" text="Pick an invoice to generate its UBL (Peppol) or India IRP payload." /> : (
        <TableScroller label="E-invoices">
          <table className="w-full text-sm">
            <thead className={THEAD}><tr><th scope="col" className={TH}>Invoice</th><th scope="col" className={TH}>Format</th><th scope="col" className={TH}>Status</th><th scope="col" className={TH}>Reference</th><th scope="col" className={TH}>Actions</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-3 py-2">{r.invoice_number ?? r.invoice_id.slice(0, 8)}</td>
                  <td className="px-3 py-2">{r.format}</td>
                  <td className="px-3 py-2"><StatusPill status={r.status} map={{ generated: "info", accepted: "success", rejected: "danger", draft: "warning" }} />{r.error && <span className="ml-2 text-xs text-muted-foreground" title={r.error}>errors</span>}</td>
                  <td className="max-w-[16rem] truncate px-3 py-2" title={r.provider_ref ?? ""}>{r.provider_ref ?? ""}</td>
                  <td className="px-3 py-2">
                    <div className="flex gap-2">
                      <Button type="button" size="sm" variant="outline" disabled={busy || r.status === "accepted"} onClick={() => void call(r.invoice_id, "generate", r.format)}>Regenerate</Button>
                      {r.status === "generated" && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void call(r.invoice_id, "submit", r.format)}>Submit (simulated)</Button>}
                      {(r.status === "generated" || r.status === "accepted") && <a className="rounded-md border border-border px-2 py-1 text-xs hover:bg-secondary" href={`/api/invoices/${r.invoice_id}/e-invoice?format=${r.format}`}>Download</a>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      )}
    </div>
  );
}
