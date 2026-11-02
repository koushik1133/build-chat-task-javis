"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { CheckCircle2, FileDown, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Banner, ErrorState, Loading } from "@/components/ui/feedback";
import { ItemsTable, PublicShell, StatusPill, type LineItem } from "@/components/billing/shared";
import { fmtDate, fmtMoney } from "@/lib/money/format";

interface PublicQuote {
  number: string; status: string; business: string; currency: string; items: LineItem[];
  subtotal_minor: number; tax_minor: number; total_minor: number; valid_until: string | null;
  terms_version: string | null; terms_text: string | null; notes: string | null; contact_name: string | null;
  accepted_at: string | null; expired: boolean;
}

type Step = "view" | "email" | "otp" | "decline" | "done" | "declined";

const spinner = <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />;

export default function PublicQuotePage() {
  const { token } = useParams<{ token: string }>();
  const [quote, setQuote] = useState<PublicQuote | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("view");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [name, setName] = useState("");
  const [signature, setSignature] = useState("");
  const [reason, setReason] = useState("");
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch(`/api/p/quotes/${token}`, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setLoadError(data?.error === "not_found" ? "This link is invalid or has expired. Ask the sender for a new one." : "Could not load the quote.");
        return;
      }
      setQuote(data.quote);
      if (data.quote.status === "accepted") setStep("done");
      else if (data.quote.status === "declined") setStep("declined");
    } catch {
      setLoadError("Could not load the quote. Check your connection and try again.");
    }
  }, [token]);
  useEffect(() => {
    void load();
  }, [load]);

  async function post(path: string, body: unknown) {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.detail ?? data?.error ?? "Request failed");
    return data;
  }

  async function requestOtp() {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/p/quotes/${token}/otp`, { email });
      setNotice(`We emailed a 6-digit code to ${email}. It expires in 10 minutes.`);
      setStep("otp");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send the code.");
    } finally {
      setBusy(false);
    }
  }

  async function accept() {
    if (!agree) {
      setError("Please confirm you agree to the terms.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const data = await post(`/api/p/quotes/${token}/accept`, { otp, name, email, signature_text: signature.trim() || name, accept_terms: true });
      setQuote(data.quote);
      setNotice(null);
      setStep("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not accept the quote.");
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    setBusy(true);
    setError(null);
    try {
      const data = await post(`/api/p/quotes/${token}/decline`, reason.trim() ? { reason: reason.trim() } : {});
      setQuote(data.quote);
      setNotice(null);
      setStep("declined");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not decline the quote.");
    } finally {
      setBusy(false);
    }
  }

  function go(next: Step) {
    setError(null);
    setStep(next);
  }

  if (loadError && !quote) {
    return (
      <PublicShell title="Quote">
        <ErrorState message={loadError} onRetry={() => void load()} />
      </PublicShell>
    );
  }
  if (!quote) {
    return (
      <PublicShell title="Quote">
        <Loading label="Loading the quote…" />
      </PublicShell>
    );
  }

  const canAct = !quote.expired && !["accepted", "declined", "expired", "draft"].includes(quote.status);
  const pdfHref = `/api/p/quotes/${token}/pdf`;
  const isAccepted = step === "done" || quote.status === "accepted";
  const isDeclined = step === "declined" || quote.status === "declined";

  return (
    <PublicShell business={quote.business} title={`Quote ${quote.number}`}>
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
        <StatusPill status={quote.expired && quote.status !== "accepted" ? "expired" : quote.status} />
        {quote.contact_name && <span>Prepared for {quote.contact_name}</span>}
        {quote.valid_until && <span>Valid until {fmtDate(quote.valid_until)}</span>}
        <Button asChild variant="outline" size="sm" touch className="ml-auto">
          <a href={pdfHref} target="_blank" rel="noopener">
            <FileDown className="h-4 w-4" aria-hidden /> Download PDF{isAccepted ? " (signed)" : ""}
          </a>
        </Button>
      </div>

      <ItemsTable items={quote.items} currency={quote.currency} totals={quote} />

      {quote.notes && <p className="mt-4 whitespace-pre-wrap text-sm text-muted-foreground [overflow-wrap:anywhere]">{quote.notes}</p>}

      {quote.terms_text && (
        <details className="mt-6 rounded-lg border border-border p-3 text-sm">
          <summary className="cursor-pointer rounded-md font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Terms {quote.terms_version ? `(${quote.terms_version})` : ""}</summary>
          <p className="mt-2 whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">{quote.terms_text}</p>
        </details>
      )}

      <section className="mt-8 rounded-lg border border-border p-4" aria-live="polite" aria-busy={busy || undefined} aria-label="Respond to this quote">
        {isAccepted ? (
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700 dark:text-emerald-300" aria-hidden />
            <div>
              <p className="font-medium">Quote accepted</p>
              <p className="text-sm text-muted-foreground">
                {quote.accepted_at ? `Accepted on ${fmtDate(quote.accepted_at)}. ` : ""}
                {quote.business} will follow up with an invoice. Your signed copy is available from the Download PDF link above.
              </p>
            </div>
          </div>
        ) : isDeclined ? (
          <div className="flex items-start gap-3">
            <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-700 dark:text-red-300" aria-hidden />
            <div>
              <p className="font-medium">Quote declined</p>
              <p className="text-sm text-muted-foreground">We have let {quote.business} know. Reach out to them if you would like a revised quote.</p>
            </div>
          </div>
        ) : !canAct ? (
          <p className="text-sm text-muted-foreground">This quote can no longer be accepted online. Contact {quote.business} for an updated quote.</p>
        ) : step === "view" ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium">Ready to go ahead?</p>
              <p className="text-sm text-muted-foreground">Total {fmtMoney(quote.total_minor, quote.currency)}. We will verify your email before recording acceptance.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button touch onClick={() => go("email")}>
                Accept quote
              </Button>
              <Button touch variant="outline" onClick={() => go("decline")}>
                Decline
              </Button>
            </div>
          </div>
        ) : step === "decline" ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void decline();
            }}
          >
            <p className="font-medium">Decline this quote?</p>
            <Field label="Reason (optional)" hint="Let them know why, so they can follow up with a better fit.">
              <Textarea rows={3} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            {error && (
              <Banner tone="error" className="mb-0" onDismiss={() => setError(null)}>
                {error}
              </Banner>
            )}
            <div className="flex flex-wrap gap-2">
              <Button touch type="submit" variant="destructive" disabled={busy}>
                {busy && spinner} Decline quote
              </Button>
              <Button touch type="button" variant="ghost" disabled={busy} onClick={() => go("view")}>
                Cancel
              </Button>
            </div>
          </form>
        ) : step === "email" ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void requestOtp();
            }}
          >
            <Field label="Your email" hint="We send a one-time code here to verify it is you." required>
              <Input type="email" required autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </Field>
            {error && (
              <Banner tone="error" className="mb-0" onDismiss={() => setError(null)}>
                {error}
              </Banner>
            )}
            <div className="flex flex-wrap gap-2">
              <Button touch type="submit" disabled={busy || !email}>
                {busy && spinner} Send code
              </Button>
              <Button touch type="button" variant="ghost" onClick={() => go("view")}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void accept();
            }}
          >
            {notice && <Banner tone="info">{notice}</Banner>}
            <Field label="6-digit code" required>
              <Input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))} className="tabular-nums" />
            </Field>
            <Field label="Your full name" required>
              <Input required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Type your name to sign" required hint="Your typed name is your electronic signature. It is stamped on the signed PDF with the date, time and a document fingerprint.">
              <Input required maxLength={200} value={signature} onChange={(e) => setSignature(e.target.value)} placeholder={name || "Your signature"} className="font-serif text-lg italic" />
            </Field>
            <Checkbox
              checked={agree}
              onChange={(e) => setAgree(e.target.checked)}
              labelClassName="items-start"
              className="mt-0.5"
              label={<>I have read and agree to the terms{quote.terms_version ? ` (${quote.terms_version})` : ""} shown above, and I agree to sign this quote electronically.</>}
            />
            {error && (
              <Banner tone="error" className="mb-0" onDismiss={() => setError(null)}>
                {error}
              </Banner>
            )}
            <div className="flex flex-wrap gap-2">
              <Button touch type="submit" disabled={busy || otp.length !== 6 || !name || !signature.trim() || !agree}>
                {busy && spinner} Sign and accept
              </Button>
              <Button touch type="button" variant="ghost" disabled={busy} onClick={() => void requestOtp()}>
                Resend code
              </Button>
            </div>
          </form>
        )}
      </section>
    </PublicShell>
  );
}
