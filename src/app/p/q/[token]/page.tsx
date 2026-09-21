"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Loader2, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ItemsTable, PublicShell, StatusPill, type LineItem } from "@/components/billing/shared";
import { fmtDate, fmtMoney } from "@/lib/money/format";

interface PublicQuote {
  number: string; status: string; business: string; currency: string; items: LineItem[];
  subtotal_minor: number; tax_minor: number; total_minor: number; valid_until: string | null;
  terms_version: string | null; terms_text: string | null; notes: string | null; contact_name: string | null;
  accepted_at: string | null; expired: boolean;
}

export default function PublicQuotePage() {
  const { token } = useParams<{ token: string }>();
  const [quote, setQuote] = useState<PublicQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<"view" | "email" | "otp" | "done">("view");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [name, setName] = useState("");
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/p/quotes/${token}`);
    const data = await res.json().catch(() => null);
    if (!res.ok) { setError(data?.error === "not_found" ? "This link is invalid or has expired." : "Could not load the quote."); return; }
    setQuote(data.quote);
    if (data.quote.status === "accepted") setStep("done");
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  async function post(path: string, body: unknown) {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.detail ?? data?.error ?? "Request failed");
    return data;
  }

  async function requestOtp() {
    setBusy(true); setError(null);
    try {
      await post(`/api/p/quotes/${token}/otp`, { email });
      setNotice(`We emailed a 6-digit code to ${email}. It expires in 10 minutes.`);
      setStep("otp");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not send the code."); }
    finally { setBusy(false); }
  }

  async function accept() {
    if (!agree) { setError("Please confirm you agree to the terms."); return; }
    setBusy(true); setError(null);
    try {
      const data = await post(`/api/p/quotes/${token}/accept`, { otp, name, email, accept_terms: true });
      setQuote(data.quote);
      setNotice(null);
      setStep("done");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not accept the quote."); }
    finally { setBusy(false); }
  }

  if (error && !quote) return <PublicShell title="Quote"><p className="text-sm text-red-600">{error}</p></PublicShell>;
  if (!quote) return <PublicShell title="Quote"><div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div></PublicShell>;

  const canAccept = !quote.expired && !["accepted", "declined", "expired", "draft"].includes(quote.status);

  return (
    <PublicShell business={quote.business} title={`Quote ${quote.number}`}>
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        <StatusPill status={quote.expired && quote.status !== "accepted" ? "expired" : quote.status} />
        {quote.contact_name && <span>Prepared for {quote.contact_name}</span>}
        {quote.valid_until && <span>Valid until {fmtDate(quote.valid_until)}</span>}
      </div>

      <ItemsTable items={quote.items} currency={quote.currency} totals={quote} />

      {quote.notes && <p className="mt-4 whitespace-pre-wrap text-sm text-muted-foreground">{quote.notes}</p>}

      {quote.terms_text && (
        <details className="mt-6 rounded-lg border border-border p-3 text-sm">
          <summary className="cursor-pointer font-medium">Terms {quote.terms_version ? `(${quote.terms_version})` : ""}</summary>
          <p className="mt-2 whitespace-pre-wrap text-muted-foreground">{quote.terms_text}</p>
        </details>
      )}

      <section className="mt-8 rounded-lg border border-border p-4">
        {step === "done" || quote.status === "accepted" ? (
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-600" aria-hidden />
            <div>
              <p className="font-medium">Quote accepted</p>
              <p className="text-sm text-muted-foreground">
                {quote.accepted_at ? `Accepted on ${fmtDate(quote.accepted_at)}. ` : ""}{quote.business} will follow up with an invoice.
              </p>
            </div>
          </div>
        ) : !canAccept ? (
          <p className="text-sm text-muted-foreground">This quote can no longer be accepted online. Contact {quote.business} for an updated quote.</p>
        ) : step === "view" ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-medium">Ready to go ahead?</p>
              <p className="text-sm text-muted-foreground">Total {fmtMoney(quote.total_minor, quote.currency)}. We will verify your email before recording acceptance.</p>
            </div>
            <Button onClick={() => setStep("email")}>Accept quote</Button>
          </div>
        ) : step === "email" ? (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void requestOtp(); }}>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Your email</span>
              <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </label>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <div className="flex gap-2">
              <Button type="submit" disabled={busy || !email}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Send code</Button>
              <Button type="button" variant="ghost" onClick={() => setStep("view")}>Cancel</Button>
            </div>
          </form>
        ) : (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void accept(); }}>
            {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
            <label className="block text-sm">
              <span className="mb-1 block font-medium">6-digit code</span>
              <Input inputMode="numeric" pattern="\d{6}" maxLength={6} required value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Your full name</span>
              <Input required value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
              <span>I have read and agree to the terms{quote.terms_version ? ` (${quote.terms_version})` : ""} shown above.</span>
            </label>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy || otp.length !== 6 || !name || !agree}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Confirm acceptance</Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => void requestOtp()}>Resend code</Button>
            </div>
          </form>
        )}
      </section>
    </PublicShell>
  );
}
