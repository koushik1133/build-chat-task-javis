"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { CheckCircle2, Clock, FileDown, Loader2, PenLine, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Banner, ErrorState, Loading } from "@/components/ui/feedback";
import { Pill } from "@/components/ui/pill";
import { MarkdownView } from "@/components/documents/markdown-view";
import { CONSENT_TEXT } from "@/lib/pdf/quote-document";
import type { PublicDocument } from "@/lib/documents/types";

type Step = "read" | "email" | "otp" | "decline" | "signed" | "declined";
const spinner = <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />;
const date = (iso: string | null) => (iso ? new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(new Date(iso)) : "");
const TONE = { pending: "neutral", viewed: "info", signed: "success", declined: "danger" } as const;

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
        setLoadError(data?.error === "expired" ? "This signing link has expired. Ask the sender for a new one." : data?.error === "not_found" ? "This link is invalid or was withdrawn. Ask the sender for a new one." : "Could not load the document.");
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

  if (loadError) return <main className="mx-auto max-w-lg px-4 py-16"><ErrorState message={loadError} onRetry={() => void load()} /></main>;
  if (!doc) return <main className="py-16"><Loading label="Loading document…" /></main>;

  const closed = doc.status === "expired" || doc.status === "void" || doc.status === "declined";
  const fullySigned = doc.status === "signed";

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:py-12">
      <header className="mb-6">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{doc.business}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{doc.title}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span className="capitalize">{doc.kind}</span>
          <Pill tone={fullySigned ? "success" : closed ? "danger" : "info"}>{doc.status}</Pill>
          {doc.expires_at && !fullySigned && !closed && <span><Clock className="mr-1 inline h-3.5 w-3.5" aria-hidden />Sign by {date(doc.expires_at)}</span>}
        </p>
      </header>

      {notice && <Banner tone="success" className="mb-4" onDismiss={() => setNotice(null)}>{notice}</Banner>}
      {error && <Banner tone="error" className="mb-4" onDismiss={() => setError(null)}>{error}</Banner>}

      <article aria-label="Document" className="rounded-xl border border-border bg-card p-5 sm:p-8">
        <MarkdownView body={doc.body_md} />
      </article>

      <section aria-label="Parties" className="mt-5 rounded-xl border border-border bg-card p-5">
        <h2 className="mb-3 text-sm font-semibold">Signers</h2>
        <ul className="space-y-2 text-sm">
          <li className="flex items-center justify-between gap-3">
            <span><span className="font-medium">{doc.signer.name}</span> <span className="text-muted-foreground">(you{doc.signer.role ? `, ${doc.signer.role}` : ""}) · {doc.signer.email_hint}</span></span>
            <Pill tone={TONE[doc.signer.status]}>{doc.signer.status}</Pill>
          </li>
          {doc.others.map((o, i) => (
            <li key={i} className="flex items-center justify-between gap-3">
              <span><span className="font-medium">{o.name}</span>{o.role && <span className="text-muted-foreground"> · {o.role}</span>}</span>
              <Pill tone={TONE[o.status]}>{o.status}</Pill>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Actions" className="mt-5 rounded-xl border border-border bg-card p-5 sm:p-6">
        {step === "signed" || fullySigned ? (
          <div className="space-y-3">
            <p className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="h-5 w-5" aria-hidden /> {fullySigned ? "Fully signed" : "Your signature is recorded"}{doc.signer.signed_at ? ` · ${date(doc.signer.signed_at)}` : ""}</p>
            {fullySigned ? (
              <Button asChild touch><a href={`/api/p/sign/${token}/pdf`}><FileDown className="h-4 w-4" aria-hidden /> Download signed PDF</a></Button>
            ) : (
              <p className="text-sm text-muted-foreground">Waiting on {doc.others.filter((o) => o.status !== "signed").map((o) => o.name).join(", ") || "the other parties"}. You will receive the completed copy by email.</p>
            )}
            {doc.signed_pdf_hash && <p className="break-all text-[11px] text-muted-foreground">Signed document SHA-256: {doc.signed_pdf_hash}</p>}
          </div>
        ) : step === "declined" || doc.status === "declined" ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><XCircle className="h-5 w-5" aria-hidden /> This document was declined.</p>
        ) : closed ? (
          <p className="text-sm text-muted-foreground">This document is {doc.status} and can no longer be signed. Contact {doc.business} for a new copy.</p>
        ) : !doc.your_turn ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Clock className="h-5 w-5" aria-hidden /> Waiting for {doc.waiting_on ?? "another signer"} to sign first. We will email you when it is your turn.</p>
        ) : step === "read" ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">Review the document above, then sign with a one-time code sent to your email.</p>
            <div className="flex gap-2">
              <Button variant="outline" touch onClick={() => { setIntent("decline"); setStep("email"); }}>Decline</Button>
              <Button touch onClick={() => { setIntent("sign"); setStep("email"); }}><PenLine className="h-4 w-4" aria-hidden /> Sign document</Button>
            </div>
          </div>
        ) : step === "email" ? (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void requestOtp(); }}>
            <Field label="Your email" hint={`Must match the address this link was sent to (${doc.signer.email_hint}).`} required>
              <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </Field>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" touch onClick={() => setStep("read")}>Back</Button>
              <Button type="submit" touch disabled={busy || !email}>{busy ? spinner : null} Email me a code</Button>
            </div>
          </form>
        ) : step === "otp" ? (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void sign(); }}>
            <Field label="6-digit code" required>
              <Input inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="one-time-code" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))} required />
            </Field>
            <Field label="Type your full name as your signature" required>
              <Input value={signature} onChange={(e) => setSignature(e.target.value)} maxLength={200} required className="font-serif text-lg italic" />
            </Field>
            <Checkbox checked={agree} onChange={(e) => setAgree(e.target.checked)} label={<span className="text-xs text-muted-foreground">{CONSENT_TEXT}</span>} />
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="ghost" touch onClick={() => void requestOtp()} disabled={busy}>Resend code</Button>
              <Button type="submit" touch disabled={busy || otp.length !== 6 || !agree}>{busy ? spinner : <PenLine className="h-4 w-4" aria-hidden />} Sign</Button>
            </div>
          </form>
        ) : (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void decline(); }}>
            <Field label="6-digit code" required>
              <Input inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="one-time-code" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))} required />
            </Field>
            <Field label="Reason (optional)">
              <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="ghost" touch onClick={() => setStep("read")}>Back</Button>
              <Button type="submit" variant="destructive" touch disabled={busy || otp.length !== 6}>{busy ? spinner : <XCircle className="h-4 w-4" aria-hidden />} Decline to sign</Button>
            </div>
          </form>
        )}
      </section>

      {doc.pdf_hash && <p className="mt-4 break-all text-[11px] text-muted-foreground">Document fingerprint (SHA-256): {doc.pdf_hash}</p>}
    </main>
  );
}
