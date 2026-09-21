"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PublicShell, StatusPill } from "@/components/billing/shared";
import { fmtMoney } from "@/lib/money/format";

interface PayInfo {
  invoice: { number: string; status: string; business: string; currency: string; total_minor: number; paid_minor: number };
  provider: string;
  outstanding_minor: number;
}

export default function SimulatedCheckoutPage() {
  const { token } = useParams<{ token: string }>();
  const search = useSearchParams();
  const [info, setInfo] = useState<PayInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<"success" | "failure" | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/p/pay/${token}`);
    const data = await res.json().catch(() => null);
    if (!res.ok) { setError(data?.error === "not_found" ? "This payment link is invalid or has expired." : "Could not load payment details."); return; }
    setInfo(data);
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  async function simulate(outcome: "success" | "failure") {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/p/pay/${token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ outcome }) });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.detail ?? data?.error ?? "Payment failed");
      setResult(outcome);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Payment failed."); }
    finally { setBusy(false); }
  }

  if (error && !info) return <PublicShell title="Payment"><p className="text-sm text-red-600">{error}</p></PublicShell>;
  if (!info) return <PublicShell title="Payment"><div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div></PublicShell>;

  // Returning from a real provider: just show the state.
  const returned = search.get("outcome");
  const paid = info.invoice.status === "paid";

  return (
    <PublicShell business={info.invoice.business} title={`Pay invoice ${info.invoice.number}`}>
      <div className="mb-4 flex items-center gap-3 text-sm text-muted-foreground"><StatusPill status={info.invoice.status} /></div>
      <div className="rounded-lg border border-border p-5">
        <p className="text-sm text-muted-foreground">Amount due</p>
        <p className="text-3xl font-semibold tabular-nums">{fmtMoney(info.outstanding_minor, info.invoice.currency)}</p>

        {paid || result === "success" ? (
          <div className="mt-5 flex items-start gap-2 text-emerald-600"><CheckCircle2 className="mt-0.5 h-5 w-5" aria-hidden /><p>Payment received. Thank you.</p></div>
        ) : result === "failure" ? (
          <div className="mt-5 flex items-start gap-2 text-red-600"><XCircle className="mt-0.5 h-5 w-5" aria-hidden /><p>Payment failed. You can try again.</p></div>
        ) : null}

        {info.provider === "simulated" ? (
          !paid && (
            <div className="mt-6 space-y-2">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Simulated checkout — no card is charged</p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void simulate("success")} disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Simulate success</Button>
                <Button variant="outline" onClick={() => void simulate("failure")} disabled={busy}>Simulate failure</Button>
              </div>
            </div>
          )
        ) : (
          <p className="mt-6 text-sm text-muted-foreground">
            {returned === "success" ? "We are confirming your payment with the provider. This page updates once it is recorded." :
             returned === "cancel" ? "Checkout was cancelled. Return to the invoice to try again." :
             "You are being redirected to the payment provider."}
          </p>
        )}
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      </div>
    </PublicShell>
  );
}
