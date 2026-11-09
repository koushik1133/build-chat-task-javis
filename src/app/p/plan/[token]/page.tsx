"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Banner, ErrorState, Loading } from "@/components/ui/feedback";
import { PublicShell } from "@/components/billing/shared";
import { Pill, type Tone } from "@/components/ui/pill";
import { fmtMoney } from "@/lib/money/format";
import type { PlanInvoiceDTO } from "@/lib/plans/checkout";

interface Info {
  invoice: PlanInvoiceDTO;
  provider: string;
}

const STATUS_TONE: Record<string, Tone> = { open: "warning", paid: "success", failed: "danger" };

/** Public checkout / return page for a KernelHub plan invoice. */
export default function PlanCheckoutPage() {
  const { token } = useParams<{ token: string }>();
  const search = useSearchParams();
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<"success" | "failure" | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/p/plan/${token}`, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(
          data?.error === "expired"
            ? "This link has expired. Start a new checkout from Settings → Plan & usage."
            : data?.error === "not_found"
              ? "This checkout link is invalid. Start a new checkout from Settings → Plan & usage."
              : "Could not load the checkout."
        );
        return;
      }
      setInfo(data as Info);
    } catch {
      setError("Could not load the checkout. Check your connection and try again.");
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function simulate(outcome: "success" | "failure") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/p/plan/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.detail ?? data?.error ?? "Payment failed");
      setResult(outcome);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Payment failed.");
    } finally {
      setBusy(false);
    }
  }

  if (error && !info) {
    return (
      <PublicShell title="KernelHub plan">
        <ErrorState message={error} onRetry={() => void load()} />
      </PublicShell>
    );
  }
  if (!info) {
    return (
      <PublicShell title="KernelHub plan">
        <Loading label="Loading checkout…" />
      </PublicShell>
    );
  }

  const purchase = info.invoice;
  const returned = search.get("outcome");
  const paid = purchase.status === "paid";

  return (
    <PublicShell title={`KernelHub ${purchase.plan_name} plan`}>
      <div className="mb-4 flex items-center gap-3 text-sm text-muted-foreground">
        <Pill tone={STATUS_TONE[purchase.status] ?? "neutral"} className="capitalize">{purchase.status}</Pill>
      </div>
      <div className="rounded-lg border border-border p-4 sm:p-5" aria-live="polite" aria-busy={busy || undefined}>
        <p className="text-sm text-muted-foreground">Amount</p>
        <p className="text-3xl font-semibold tabular-nums">{fmtMoney(purchase.amount_minor, purchase.currency)}</p>
        <p className="mt-1 text-sm capitalize text-muted-foreground">{purchase.kind === "upgrade" ? "Prorated upgrade" : purchase.kind === "seats" ? "Seat change" : `${purchase.billing_interval === "year" ? "Annual" : "Monthly"} subscription`} · {purchase.seats} seat{purchase.seats === 1 ? "" : "s"}</p>

        {paid || result === "success" ? (
          <div className="mt-5 flex items-start gap-2 text-emerald-700 dark:text-emerald-300" role="status">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
            <p>Payment received. Your plan is active.</p>
          </div>
        ) : purchase.status === "failed" || result === "failure" ? (
          <div className="mt-5 flex items-start gap-2 text-red-700 dark:text-red-300" role="status">
            <XCircle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
            <p>Payment failed. Start a new checkout from Settings → Plan & usage.</p>
          </div>
        ) : null}

        {info.provider === "simulated" ? (
          !paid &&
          purchase.status === "open" && (
            <div className="mt-6 space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Simulated checkout — no card is charged</p>
              <div className="flex flex-wrap gap-2">
                <Button touch onClick={() => void simulate("success")} disabled={busy}>
                  {busy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />} Simulate success
                </Button>
                <Button touch variant="outline" onClick={() => void simulate("failure")} disabled={busy}>
                  Simulate failure
                </Button>
              </div>
            </div>
          )
        ) : (
          <p className="mt-6 text-sm text-muted-foreground">
            {returned === "success"
              ? "We are confirming your payment with the provider. This page updates once it is recorded."
              : returned === "cancel"
                ? "Checkout was cancelled. Start again from Settings → Plan & usage."
                : "You are being redirected to the payment provider."}
          </p>
        )}
        {error && (
          <Banner tone="error" className="mt-4" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        )}
      </div>
      <p className="mt-4 text-sm">
        <Link href="/settings/plan" className="inline-flex min-h-11 items-center rounded-md underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0">
          Back to plan settings
        </Link>
      </p>
    </PublicShell>
  );
}
