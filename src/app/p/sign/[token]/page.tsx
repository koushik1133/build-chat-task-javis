"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { AlertTriangle, CheckCircle2, Clock, FileDown, Loader2, PenLine, RefreshCw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Banner, Skeleton } from "@/components/ui/feedback";
import { Pill } from "@/components/ui/pill";
import { MarkdownView } from "@/components/documents/markdown-view";
import { CONSENT_TEXT } from "@/lib/pdf/quote-document";
import type { PublicDocument } from "@/lib/documents/types";

/*
 * Public e-sign page. Phone first: a reading view, then a short OTP flow
 * (email → 6-digit code → typed signature + consent) with full-width 44px
 * buttons. Everything announces through the Banner live regions.
 */

type Step = "read" | "email" | "otp" | "decline" | "signed" | "declined";
const spinner = <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />;
const date = (iso: string | null) => (iso ? new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(new Date(iso)) : "");
const TONE = { pending: "neutral", viewed: "info", signed: "success", declined: "danger" } as const;
const LABEL = { pending: "Pending", viewed: "Viewed", signed: "Signed", declined: "Declined" } as const;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function OtpInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Input
      inputMode="numeric"
      pattern="[0-9]{6}"
      maxLength={6}
      autoComplete="one-time-code"
      enterKeyHint="done"
      autoFocus
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
      required
      className="h-14 text-center text-2xl font-semibold tracking-[0.5em] tabular-nums sm:h-12"
    />
  );
}

export default function PublicSignPage() {
  const { token } = useParams<{ token: string }>();
  const [doc, setDoc] = useState<PublicDocument | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("read");
  const [intent, setIntent] = useState<"sign" | "decline">("sign");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [signature, setSignature] = useState("");
  const [reason, setReason] = useState("");
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch(`/api/p/sign/${token}`, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setLoadError(
          data?.error === "expired"
            ? "This signing link has expired. Ask the sender for a new one."
            : data?.error === "not_found"
              ? "This link is invalid or was withdrawn. Ask the sender for a new one."
              : "Could not load the document."
        );
        return;
      }
      const d = data.document as PublicDocument;
      setDoc(d);
      setSignature((s) => s || d.signer.name);
      if (d.signer.status === "signed") setStep("signed");
      else if (d.status === "declined" || d.signer.status === "declined") setStep("declined");
    } catch {
      setLoadError("Could not load the document. Check your connection and try again.");
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
      await post(`/api/p/sign/${token}/otp`, { email, purpose: intent });
      setNotice(`We emailed a 6-digit code to ${email}. It expires in 10 minutes.`);
      setStep(intent === "sign" ? "otp" : "decline");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send the code");
    } finally {
      setBusy(false);
    }
  }

  async function sign() {
    if (!agree) {
      setError("Please confirm you agree to sign electronically.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const out = await post(`/api/p/sign/${token}/sign`, { otp, email, signature_text: signature.trim() || doc?.signer.name, consent: true });
      setDoc(out.document);
      setStep("signed");
      setNotice(out.completed ? "Everyone has signed. The completed document is ready to download." : "Thank you — your signature is recorded. You will be able to download the completed document once all parties have signed.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not sign");
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    setBusy(true);
    setError(null);
    try {
      const out = await post(`/api/p/sign/${token}/decline`, { otp, email, reason: reason.trim() || null });
      setDoc(out.document);
      setStep("declined");
      setNotice("You declined to sign. The sender has been notified.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not decline");
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center px-4 py-16 text-center">
        <AlertTriangle className="mb-3 h-8 w-8 text-muted-foreground" aria-hidden />
        <h1 className="text-lg font-semibold">Link unavailable</h1>
        <p role="alert" className="mt-2 text-sm text-muted-foreground">{loadError}</p>
        <Button variant="outline" touch className="mt-6 w-full sm:w-auto" onClick={() => void load()}>
          <RefreshCw className="h-4 w-4" aria-hidden /> Try again
        </Button>
      </main>
    );
  }

  if (!doc) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:py-12" aria-busy="true">
        <div role="status" aria-live="polite" className="space-y-5">
          <div className="space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-7 w-3/4" />
            <Skeleton className="h-4 w-40" />
          </div>
          <Skeleton className="h-72 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
          <span className="sr-only">Loading document…</span>
        </div>
      </main>
    );
  }

  const closed = doc.status === "expired" || doc.status === "void" || doc.status === "declined";
  const fullySigned = doc.status === "signed";
  const codeField = (
    <Field label="6-digit code" hint="Check your email. Codes expire after 10 minutes." required>
      <OtpInput value={otp} onChange={setOtp} />
    </Field>
  );

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-8 sm:py-12">
      <header className="mb-6">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{doc.business}</p>
        <h1 className="mt-1 break-words text-2xl font-semibold tracking-tight">{doc.title}</h1>
        <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>{cap(doc.kind)}</span>
          <Pill tone={fullySigned ? "success" : closed ? "danger" : "info"}>{cap(doc.status)}</Pill>
          {doc.expires_at && !fullySigned && !closed && (
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" aria-hidden /> Sign by {date(doc.expires_at)}
            </span>
          )}
        </p>
      </header>

      {notice && <Banner tone="success" className="mb-4" onDismiss={() => setNotice(null)}>{notice}</Banner>}
      {error && <Banner tone="error" className="mb-4" onDismiss={() => setError(null)}>{error}</Banner>}

      <article aria-label="Document" className="rounded-xl border border-border bg-card p-5 sm:p-8">
        <MarkdownView body={doc.body_md} className="text-base leading-7 sm:text-sm sm:leading-relaxed" />
      </article>

      <section aria-labelledby="signers-heading" className="mt-5 rounded-xl border border-border bg-card p-5">
        <h2 id="signers-heading" className="mb-3 text-sm font-semibold">Signers</h2>
        <ul className="space-y-2 text-sm">
          <li className="flex items-center justify-between gap-3">
            <span className="min-w-0 break-words">
              <span className="font-medium">{doc.signer.name}</span>{" "}
              <span className="text-muted-foreground">(you{doc.signer.role ? `, ${doc.signer.role}` : ""}) · {doc.signer.email_hint}</span>
            </span>
            <Pill tone={TONE[doc.signer.status]} className="shrink-0">{LABEL[doc.signer.status]}</Pill>
          </li>
          {doc.others.map((o, i) => (
            <li key={i} className="flex items-center justify-between gap-3">
              <span className="min-w-0 break-words">
                <span className="font-medium">{o.name}</span>
                {o.role && <span className="text-muted-foreground"> · {o.role}</span>}
              </span>
              <Pill tone={TONE[o.status]} className="shrink-0">{LABEL[o.status]}</Pill>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="actions-heading" className="mt-5 rounded-xl border border-border bg-card p-5 sm:p-6">
        <h2 id="actions-heading" className="sr-only">Sign or decline</h2>
        {step === "signed" || fullySigned ? (
          <div className="space-y-3">
            <p className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden /> {fullySigned ? "Fully signed" : "Your signature is recorded"}
              {doc.signer.signed_at ? ` · ${date(doc.signer.signed_at)}` : ""}
            </p>
            {fullySigned ? (
              <Button asChild touch size="lg" className="w-full sm:w-auto">
                <a href={`/api/p/sign/${token}/pdf`}>
                  <FileDown className="h-4 w-4" aria-hidden /> Download signed PDF
                </a>
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">Waiting on {doc.others.filter((o) => o.status !== "signed").map((o) => o.name).join(", ") || "the other parties"}. You will receive the completed copy by email.</p>
            )}
            {doc.signed_pdf_hash && <p className="break-all text-[11px] text-muted-foreground">Signed document SHA-256: {doc.signed_pdf_hash}</p>}
          </div>
        ) : step === "declined" || doc.status === "declined" ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <XCircle className="h-5 w-5 shrink-0" aria-hidden /> This document was declined.
          </p>
        ) : closed ? (
          <p className="text-sm text-muted-foreground">This document is {doc.status} and can no longer be signed. Contact {doc.business} for a new copy.</p>
        ) : !doc.your_turn ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Clock className="h-5 w-5 shrink-0" aria-hidden /> Waiting for {doc.waiting_on ?? "another signer"} to sign first. We will email you when it is your turn.
          </p>
        ) : step === "read" ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">Review the document above, then sign with a one-time code sent to your email.</p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:shrink-0">
              <Button variant="outline" touch size="lg" className="w-full sm:w-auto" onClick={() => { setIntent("decline"); setStep("email"); }}>
                Decline
              </Button>
              <Button touch size="lg" className="w-full sm:w-auto" onClick={() => { setIntent("sign"); setStep("email"); }}>
                <PenLine className="h-4 w-4" aria-hidden /> Sign document
              </Button>
            </div>
          </div>
        ) : step === "email" ? (
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void requestOtp(); }}>
            <Field label="Your email" hint={`Must match the address this link was sent to (${doc.signer.email_hint}).`} required>
              <Input type="email" inputMode="email" autoComplete="email" enterKeyHint="send" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} required />
            </Field>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="ghost" touch size="lg" className="w-full sm:w-auto" onClick={() => setStep("read")}>
                Back
              </Button>
              <Button type="submit" touch size="lg" className="w-full sm:w-auto" disabled={busy || !email}>
                {busy ? spinner : null} Email me a code
              </Button>
            </div>
          </form>
        ) : step === "otp" ? (
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void sign(); }}>
            {codeField}
            <Field label="Type your full name as your signature" required>
              <Input value={signature} onChange={(e) => setSignature(e.target.value)} maxLength={200} autoComplete="name" required className="h-14 font-serif text-xl italic sm:h-12" />
            </Field>
            <Checkbox checked={agree} onChange={(e) => setAgree(e.target.checked)} labelClassName="items-start" label={<span className="text-xs leading-relaxed text-muted-foreground">{CONSENT_TEXT}</span>} />
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="ghost" touch size="lg" className="w-full sm:w-auto" onClick={() => void requestOtp()} disabled={busy}>
                Resend code
              </Button>
              <Button type="submit" touch size="lg" className="w-full sm:w-auto" disabled={busy || otp.length !== 6 || !agree}>
                {busy ? spinner : <PenLine className="h-4 w-4" aria-hidden />} Sign
              </Button>
            </div>
          </form>
        ) : (
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void decline(); }}>
            {codeField}
            <Field label="Reason (optional)">
              <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
            </Field>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="ghost" touch size="lg" className="w-full sm:w-auto" onClick={() => setStep("read")}>
                Back
              </Button>
              <Button type="submit" variant="destructive" touch size="lg" className="w-full sm:w-auto" disabled={busy || otp.length !== 6}>
                {busy ? spinner : <XCircle className="h-4 w-4" aria-hidden />} Decline to sign
              </Button>
            </div>
          </form>
        )}
      </section>

      {doc.pdf_hash && <p className="mt-4 break-all text-[11px] text-muted-foreground">Document fingerprint (SHA-256): {doc.pdf_hash}</p>}
    </main>
  );
}
