"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ItemsTable, PublicShell, StatusPill, type LineItem } from "@/components/billing/shared";
import { fmtDate, fmtMoney } from "@/lib/money/format";

interface PublicInvoice {
  number: string; status: string; business: string; currency: string; items: LineItem[];
  subtotal_minor: number; tax_minor: number; total_minor: number; paid_minor: number;
  due_at: string | null; notes: string | null; contact_name: string | null;
}

export default function PublicInvoicePage() {
  const { token } = useParams<{ token: string }>();
  const [inv, setInv] = useState<PublicInvoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/p/invoices/${token}`);
    const data = await res.json().catch(() => null);
    if (!res.ok) { setError(data?.error === "not_found" ? "This link is invalid or has expired." : "Could not load the invoice."); return; }
    setInv(data.invoice);
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  async function pay() {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/p/invoices/${token}`, { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.detail ?? data?.error ?? "Could not start payment");
      window.location.href = data.url;
    } catch (e) { setError(e instanceof Error ? e.message : "Could not start payment."); setBusy(false); }
  }

  if (error && !inv) return <PublicShell title="Invoice"><p className="text-sm text-red-600">{error}</p></PublicShell>;
  if (!inv) return <PublicShell title="Invoice"><div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div></PublicShell>;

  const outstanding = Math.max(inv.total_minor - inv.paid_minor, 0);
  const payable = inv.status !== "paid" && inv.status !== "void" && outstanding > 0;

  return (
    <PublicShell business={inv.business} title={`Invoice ${inv.number}`}>
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        <StatusPill status={inv.status} />
        {inv.contact_name && <span>Billed to {inv.contact_name}</span>}
        {inv.due_at && <span>Due {fmtDate(inv.due_at)}</span>}
      </div>
      <ItemsTable items={inv.items} currency={inv.currency} totals={inv} />
      {inv.notes && <p className="mt-4 whitespace-pre-wrap text-sm text-muted-foreground">{inv.notes}</p>}
      <section className="mt-8 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4">
        <div>
          <p className="font-medium">{payable ? `Outstanding ${fmtMoney(outstanding, inv.currency)}` : inv.status === "paid" ? "Paid in full — thank you." : "No payment due."}</p>
          {inv.paid_minor > 0 && <p className="text-sm text-muted-foreground">Paid so far {fmtMoney(inv.paid_minor, inv.currency)}</p>}
        </div>
        {payable && <Button onClick={() => void pay()} disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Pay now</Button>}
      </section>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </PublicShell>
  );
}
