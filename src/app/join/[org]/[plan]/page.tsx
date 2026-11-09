"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Banner, ErrorState, Loading } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { Checkbox, Input } from "@/components/ui/input";
import { renderMarkdown } from "@/lib/privacy/markdown";
import { fmtMoney } from "@/lib/money/format";
import { isSafeRelativePath } from "@/lib/safe-next";

interface JoinPlan {
  slug: string;
  name: string;
  description_md: string | null;
  amount_minor: number;
  currency: string;
  interval: string;
  interval_count: number;
  trial_days: number;
  setup_fee_minor: number;
  benefits: Array<{ label: string }>;
  allow_quantity: boolean;
  full: boolean;
  tax: { name: string; rate_bp: number } | null;
}

function every(interval: string, count: number): string {
  return count === 1 ? interval : `${count} ${interval}s`;
}

export default function JoinPage() {
  const { org, plan: planSlug } = useParams<{ org: string; plan: string }>();
  const [plan, setPlan] = useState<JoinPlan | null>(null);
  const [orgName, setOrgName] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [terms, setTerms] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ trialEndsAt: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/join/${encodeURIComponent(org)}/${encodeURIComponent(planSlug)}`);
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.plan) throw new Error(res.status === 404 ? "This plan is not available." : "Could not load this plan.");
      setPlan(data.plan);
      setOrgName(data.org?.name ?? "");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load this plan.");
    } finally {
      setLoading(false);
    }
  }, [org, planSlug]);
  useEffect(() => {
    void load();
  }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/join/${encodeURIComponent(org)}/${encodeURIComponent(planSlug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact: { name, email, ...(phone.trim() ? { phone } : {}) }, quantity, consent: { terms: true, marketing } }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        if (data?.error === "rate_limited") throw new Error("Too many attempts. Please wait a moment and try again.");
        if (data?.error === "invalid_body") throw new Error("Please check your details and try again.");
        throw new Error(data?.detail ?? "Could not start your membership.");
      }
      if (data.pay_url) {
        // The pay page lives on this site: follow only its path, never an arbitrary host.
        let path = "";
        try {
          path = new URL(String(data.pay_url), window.location.origin).pathname;
        } catch {
          path = "";
        }
        if (isSafeRelativePath(path) && path.startsWith("/p/pay/")) {
          window.location.assign(path);
          return;
        }
        throw new Error("Could not open the payment page.");
      }
      setDone({ trialEndsAt: data.trial_ends_at ?? "" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start your membership.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6"><Loading label="Loading plan…" /></div>;
  if (loadError || !plan) return <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6"><ErrorState message={loadError ?? "This plan is not available."} onRetry={load} /></div>;

  if (done) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
        <div className="rounded-lg border border-border p-6 text-center" role="status">
          <Check className="mx-auto h-8 w-8 text-emerald-600" aria-hidden />
          <h1 className="mt-3 text-xl font-semibold">You are in</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Your {plan.name} trial has started{done.trialEndsAt ? ` and runs until ${new Date(done.trialEndsAt).toLocaleDateString()}` : ""}. We will email you before it ends.
          </p>
        </div>
      </div>
    );
  }

  const total = plan.amount_minor * (plan.allow_quantity ? quantity : 1);
  const todayDue = plan.trial_days > 0 ? plan.setup_fee_minor : total + plan.setup_fee_minor;

  return (
    <div className="mx-auto grid w-full max-w-3xl gap-8 px-4 py-8 sm:px-6 md:grid-cols-[1fr_320px]">
      <section aria-labelledby="plan-name" className="min-w-0">
        {orgName && <p className="text-sm text-muted-foreground">{orgName}</p>}
        <h1 id="plan-name" className="mt-1 text-2xl font-semibold">{plan.name}</h1>
        <p className="mt-2 text-3xl font-semibold tabular-nums">
          {fmtMoney(plan.amount_minor, plan.currency)} <span className="text-base font-normal text-muted-foreground">/ {every(plan.interval, plan.interval_count)}</span>
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {plan.tax ? `Plus ${plan.tax.name} (${(plan.tax.rate_bp / 100).toFixed(2).replace(/\.00$/, "")}%).` : "Taxes, if any, are added at checkout."}
          {plan.trial_days > 0 && ` ${plan.trial_days}-day free trial.`}
          {plan.setup_fee_minor > 0 && ` One-time setup fee ${fmtMoney(plan.setup_fee_minor, plan.currency)}.`}
        </p>
        {plan.description_md && <div className="prose prose-sm mt-4 max-w-prose dark:prose-invert" dangerouslySetInnerHTML={{ __html: renderMarkdown(plan.description_md) }} />}
        {plan.benefits.length > 0 && (
          <ul className="mt-4 space-y-2" aria-label="What is included">
            {plan.benefits.map((b, i) => (
              <li key={`${i}-${b.label}`} className="flex items-start gap-2 text-sm">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
                <span>{b.label}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <form onSubmit={submit} className="space-y-3 rounded-lg border border-border p-4" aria-label="Join this plan" noValidate>
        {plan.full && <Banner tone="warn">This plan is currently full.</Banner>}
        {error && <Banner tone="error">{error}</Banner>}
        <Field label="Full name" required><Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required maxLength={200} /></Field>
        <Field label="Email" required><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required maxLength={320} /></Field>
        <Field label="Phone"><Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" maxLength={40} /></Field>
        {plan.allow_quantity && (
          <Field label="Quantity"><Input type="number" min={1} max={100} value={quantity} onChange={(e) => setQuantity(Math.min(100, Math.max(1, Number(e.target.value) || 1)))} /></Field>
        )}
        <div className="rounded-md bg-secondary/40 p-3 text-sm">
          <div className="flex justify-between"><span>Due today</span><strong className="tabular-nums">{fmtMoney(todayDue, plan.currency)}</strong></div>
          {plan.trial_days > 0 && <p className="mt-1 text-xs text-muted-foreground">Then {fmtMoney(total, plan.currency)} every {every(plan.interval, plan.interval_count)} after your trial.</p>}
        </div>
        <Checkbox checked={terms} onChange={(e) => setTerms(e.target.checked)} label="I agree to be billed on a recurring basis and can cancel at any time." required />
        <Checkbox checked={marketing} onChange={(e) => setMarketing(e.target.checked)} label="Send me news and offers (optional)." />
        {!terms && <p className="text-xs text-muted-foreground">Tick the agreement above to continue.</p>}
        <Button type="submit" className="w-full" disabled={busy || plan.full || !terms || !name.trim() || !email.trim()} touch>
          {busy ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : null}
          {plan.trial_days > 0 ? "Start free trial" : "Start membership"}
        </Button>
      </form>
    </div>
  );
}
