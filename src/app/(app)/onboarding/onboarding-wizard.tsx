"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Bot, Building2, CheckCircle2, Database, ExternalLink, Loader2, Pencil, Plug, Rocket, Users, Wrench } from "lucide-react";
import { PageContainer } from "@/components/page-container";
import { Button } from "@/components/ui/button";
import { Banner, Skeleton } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { Checkbox, Input, Select } from "@/components/ui/input";
import { Pill } from "@/components/ui/pill";
import { cn } from "@/lib/utils";

/* ── types ─────────────────────────────────────────────────────────────── */

interface PackListing { slug: string; name: string; description: string; icon: string; installed: boolean }
interface OrgSettingsDTO {
  settings: { locale: string; currency: string; timezone: string };
  locales: Array<{ code: string; label: string }>;
  currencies: Array<{ code: string; symbol: string; name: string }>;
}
interface IntegrationsView { slack_connected?: boolean; email_connected?: boolean; twilio_from_number?: string | null }

type Autonomy = "draft" | "approve" | "auto";
type ModuleKey = "booking" | "invoicing" | "helpdesk" | "inventory" | "voice_mail";

interface WizardState {
  companyName: string;
  industry: string;
  country: string;
  currency: string;
  timezone: string;
  locale: string;
  packs: string[];
  modules: Record<ModuleKey, boolean>;
  invites: string[];
  inviteDraft: string;
  autonomy: Autonomy;
  playbooks: boolean;
  outcomePricing: boolean;
}

const STEPS = [
  { id: "basics", label: "Your business", hint: "Name, industry and locale", icon: Building2 },
  { id: "modules", label: "What you do", hint: "Record packs and modules", icon: Wrench },
  { id: "team", label: "Team", hint: "Invite teammates", icon: Users },
  { id: "ai", label: "AI preferences", hint: "How much agents may do", icon: Bot },
  { id: "channels", label: "Channels", hint: "Where customers reach you", icon: Plug },
  { id: "finish", label: "Finish", hint: "Review and go", icon: Rocket },
] as const;
type StepId = (typeof STEPS)[number]["id"];

const COUNTRIES = ["United States", "United Kingdom", "Canada", "Australia", "India", "Germany", "France", "Spain", "Mexico", "Brazil", "Singapore", "United Arab Emirates", "Other"];

const MODULES: ReadonlyArray<{ key: ModuleKey; label: string; text: string }> = [
  { key: "booking", label: "Online booking", text: "A public booking page with a default calendar and an intro-call type." },
  { key: "invoicing", label: "Quotes and invoicing", text: "Send quotes, convert accepted ones to invoices, take payments." },
  { key: "helpdesk", label: "Helpdesk and SLAs", text: "Tickets from email, chat and portal with a standard SLA policy." },
  { key: "inventory", label: "Inventory and stock", text: "Products with stock levels, reorder points and equipment checkouts." },
  { key: "voice_mail", label: "Voice and mail campaigns", text: "Outbound calls and a synced inbox for follow-ups." },
];

const AUTONOMY: Array<{ id: Autonomy; label: string; text: string }> = [
  { id: "draft", label: "Draft only", text: "Agents prepare work; you send and save everything yourself." },
  { id: "approve", label: "Ask before acting", text: "Agents do the work and pause for approval on anything external. Recommended." },
  { id: "auto", label: "Autonomous", text: "Agents act within their tool allowlist without waiting. Best once you trust the playbooks." },
];

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function readError(res: Response, fallback: string): Promise<string> {
  const d = await res.json().catch(() => null);
  return typeof d?.error === "string" ? (typeof d?.detail === "string" ? `${d.error}: ${d.detail}` : d.error) : `${fallback} (${res.status})`;
}

function timezones(): string[] {
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
    const list = intl.supportedValuesOf?.("timeZone");
    if (list && list.length > 0) return list;
  } catch {
    // fall through
  }
  return ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Asia/Kolkata", "Asia/Singapore", "Australia/Sydney"];
}

/* ── component ─────────────────────────────────────────────────────────── */

export function OnboardingWizard() {
  const router = useRouter();
  const [step, setStep] = useState<StepId>("basics");
  const [packs, setPacks] = useState<PackListing[] | null>(null);
  const [options, setOptions] = useState<OrgSettingsDTO | null>(null);
  const [integrations, setIntegrations] = useState<IntegrationsView | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<"companyName" | "industry" | "invite", string>>>({});
  const [inviteResults, setInviteResults] = useState<Record<string, "sent" | "member" | "failed">>({});
  const [finish, setFinish] = useState<{ packsInstalled: string[]; agentsCreated: number; warnings: string[] } | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [seeded, setSeeded] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(false);

  const [s, setS] = useState<WizardState>({
    companyName: "",
    industry: "",
    country: "United States",
    currency: "USD",
    timezone: "UTC",
    locale: "en",
    packs: [],
    modules: { booking: true, invoicing: true, helpdesk: false, inventory: false, voice_mail: false },
    invites: [],
    inviteDraft: "",
    autonomy: "approve",
    playbooks: true,
    outcomePricing: false,
  });
  const patch = (p: Partial<WizardState>) => setS((prev) => ({ ...prev, ...p }));

  useEffect(() => {
    const ac = new AbortController();
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    (async () => {
      const [p, o, i] = await Promise.all([
        fetch("/api/records/packs", { signal: ac.signal }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch("/api/orgs/settings", { signal: ac.signal }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch("/api/integrations", { signal: ac.signal }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      if (ac.signal.aborted) return;
      setPacks((p?.packs as PackListing[] | undefined) ?? []);
      if (o?.settings) {
        setOptions(o as OrgSettingsDTO);
        setS((prev) => ({ ...prev, currency: o.settings.currency ?? prev.currency, timezone: o.settings.timezone ?? browserTz, locale: o.settings.locale ?? prev.locale }));
      } else {
        setOptions({ settings: { locale: "en", currency: "USD", timezone: browserTz }, locales: [{ code: "en", label: "English" }], currencies: [{ code: "USD", symbol: "$", name: "US Dollar" }] });
        setS((prev) => ({ ...prev, timezone: browserTz }));
      }
      setIntegrations((i?.integrations as IntegrationsView | undefined) ?? {});
    })();
    return () => ac.abort();
  }, []);

  // Move focus to the step heading on every step change (not on first paint) so keyboard and screen-reader users land in the new content.
  useEffect(() => {
    if (mounted.current) headingRef.current?.focus();
    mounted.current = true;
  }, [step]);

  const tzList = useMemo(timezones, []);
  const stepIndex = STEPS.findIndex((x) => x.id === step);
  const current = STEPS[stepIndex];
  const progress = Math.round((stepIndex / (STEPS.length - 1)) * 100);

  const validateBasics = useCallback((): boolean => {
    const errs: typeof fieldErrors = {};
    if (!s.companyName.trim()) errs.companyName = "Give your business a name.";
    if (!s.industry) errs.industry = "Pick the industry closest to what you do.";
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }, [s.companyName, s.industry]);

  const saveBasics = useCallback(async () => {
    const [a, b, c] = await Promise.all([
      fetch("/api/orgs/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ locale: s.locale, currency: s.currency, timezone: s.timezone }) }),
      fetch("/api/orgs/branding", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ brand_name: s.companyName.trim() }) }),
      fetch("/api/onboarding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ company_name: s.companyName.trim(), industry: s.industry, stage: "", team_size: "", geography: s.country, modules: Object.entries(s.modules).filter(([, v]) => v).map(([k]) => k) }) }),
    ]);
    if (!a.ok) throw new Error(await readError(a, "Could not save locale settings"));
    if (!b.ok && b.status !== 404) throw new Error(await readError(b, "Could not save the brand name"));
    if (!c.ok) throw new Error(await readError(c, "Could not save the business profile"));
  }, [s]);

  const sendInvites = useCallback(async () => {
    const results: Record<string, "sent" | "member" | "failed"> = {};
    for (const email of s.invites) {
      if (inviteResults[email] === "sent" || inviteResults[email] === "member") { results[email] = inviteResults[email]; continue; }
      const res = await fetch("/api/team/invite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, role: "member" }) });
      results[email] = res.ok ? "sent" : res.status === 409 ? "member" : "failed";
    }
    setInviteResults(results);
  }, [s.invites, inviteResults]);

  const complete = useCallback(async () => {
    const res = await fetch("/api/onboarding/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ industry: s.industry, packs: s.packs, modules: s.modules, ai: { autonomy: s.autonomy, playbooks: s.playbooks, outcome_pricing: s.outcomePricing } }),
    });
    if (!res.ok) throw new Error(await readError(res, "Could not finish setup"));
    setFinish((await res.json()) as { packsInstalled: string[]; agentsCreated: number; warnings: string[] });
  }, [s]);

  const next = async () => {
    setError(null);
    if (step === "basics" && !validateBasics()) return;
    setSaving(true);
    try {
      if (step === "basics") await saveBasics();
      if (step === "team") await sendInvites();
      if (step === "channels") await complete();
      setStep(STEPS[Math.min(STEPS.length - 1, stepIndex + 1)].id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSaving(false);
    }
  };
  const back = () => {
    setError(null);
    setFieldErrors({});
    setStep(STEPS[Math.max(0, stepIndex - 1)].id);
  };
  const goTo = (id: StepId) => {
    setError(null);
    setFieldErrors({});
    setStep(id);
  };

  const seed = async () => {
    setSeeding(true);
    setError(null);
    try {
      const res = await fetch("/api/demo/seed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ industry: s.industry || undefined, currency: s.currency }) });
      if (!res.ok) throw new Error(await readError(res, "Could not load sample data"));
      setSeeded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load sample data");
    } finally {
      setSeeding(false);
    }
  };

  const addInvite = () => {
    const v = s.inviteDraft.trim().toLowerCase();
    if (!EMAIL_RE.test(v)) {
      setFieldErrors((f) => ({ ...f, invite: "Enter a valid email address, like name@company.com." }));
      return;
    }
    setFieldErrors((f) => ({ ...f, invite: undefined }));
    if (s.invites.includes(v)) { patch({ inviteDraft: "" }); return; }
    patch({ invites: [...s.invites, v], inviteDraft: "" });
  };

  const loading = packs === null || options === null;
  const industryName = packs?.find((p) => p.slug === s.industry)?.name ?? s.industry;
  const chosenPacks = useMemo(() => (packs ?? []).filter((p) => p.slug === s.industry || s.packs.includes(p.slug) || p.installed), [packs, s.industry, s.packs]);
  const enabledModules = MODULES.filter((m) => s.modules[m.key]);

  return (
    <PageContainer title="Set up your workspace" description="Six short steps. Everything here can be changed later in Settings." icon={<Rocket className="h-5 w-5" />} className="pb-24">
      {/* Progress */}
      <nav aria-label="Setup progress" className="mb-6">
        <p className="mb-2 text-xs text-muted-foreground" aria-live="polite">
          Step {stepIndex + 1} of {STEPS.length} · {current.label}
        </p>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label="Setup progress">
          <div className="h-full rounded-full bg-primary transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${progress}%` }} />
        </div>
        <ol className="mt-3 grid grid-cols-6 gap-1 sm:gap-2">
          {STEPS.map((st, i) => {
            const Icon = st.icon;
            const state = i < stepIndex ? "done" : i === stepIndex ? "current" : "todo";
            const reachable = state === "done" && step !== "finish";
            const inner = (
              <>
                <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs", state === "current" && "border-primary bg-primary text-primary-foreground", state === "done" && "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300", state === "todo" && "border-border text-muted-foreground")} aria-hidden>
                  {state === "done" ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}
                </span>
                <span className={cn("hidden truncate text-xs sm:block", state === "current" ? "font-medium text-foreground" : "text-muted-foreground")}>{st.label}</span>
                <span className="sr-only">{state === "done" ? "Completed: " : state === "current" ? "Current step: " : "Upcoming: "}{st.label}</span>
              </>
            );
            return (
              <li key={st.id} aria-current={state === "current" ? "step" : undefined} className="min-w-0">
                {reachable ? (
                  <button type="button" onClick={() => goTo(st.id)} className="flex min-h-11 w-full flex-col items-center gap-1 rounded-md px-1 py-1 hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0">
                    {inner}
                  </button>
                ) : (
                  <div className="flex min-h-11 w-full flex-col items-center gap-1 px-1 py-1 sm:min-h-0">{inner}</div>
                )}
              </li>
            );
          })}
        </ol>
      </nav>

      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}

      {loading ? (
        <div className="rounded-xl border border-border bg-card p-4 sm:p-6" role="status" aria-busy="true">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="mt-2 h-3 w-64" />
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
          </div>
          <span className="sr-only">Loading your workspace…</span>
        </div>
      ) : (
        <form
          className="rounded-xl border border-border bg-card p-4 sm:p-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (step !== "finish") void next();
          }}
          aria-labelledby="step-heading"
        >
          <header className="mb-5">
            <h2 id="step-heading" ref={headingRef} tabIndex={-1} className="text-base font-semibold focus-visible:outline-none">{current.label}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{current.hint}</p>
          </header>

          {step === "basics" && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Business name" required error={fieldErrors.companyName} className="sm:col-span-2">
                <Input value={s.companyName} onChange={(e) => { patch({ companyName: e.target.value }); if (fieldErrors.companyName) setFieldErrors((f) => ({ ...f, companyName: undefined })); }} placeholder="e.g. Northwind Studio" maxLength={80} autoComplete="organization" />
              </Field>
              <Field label="Industry" required hint="Picks your starter record types and agents." error={fieldErrors.industry} className="sm:col-span-2">
                <Select value={s.industry} onChange={(e) => { patch({ industry: e.target.value }); if (fieldErrors.industry) setFieldErrors((f) => ({ ...f, industry: undefined })); }}>
                  <option value="">Choose an industry…</option>
                  {packs!.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
                </Select>
              </Field>
              <Field label="Country">
                <Select value={s.country} onChange={(e) => patch({ country: e.target.value })} autoComplete="country-name">
                  {COUNTRIES.map((c) => <option key={c}>{c}</option>)}
                </Select>
              </Field>
              <Field label="Currency">
                <Select value={s.currency} onChange={(e) => patch({ currency: e.target.value })}>
                  {options!.currencies.map((c) => <option key={c.code} value={c.code}>{c.code} — {c.name}</option>)}
                </Select>
              </Field>
              <Field label="Timezone">
                <Select value={s.timezone} onChange={(e) => patch({ timezone: e.target.value })}>
                  {!tzList.includes(s.timezone) && <option value={s.timezone}>{s.timezone}</option>}
                  {tzList.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                </Select>
              </Field>
              <Field label="Language">
                <Select value={s.locale} onChange={(e) => patch({ locale: e.target.value })}>
                  {options!.locales.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
                </Select>
              </Field>
            </div>
          )}

          {step === "modules" && (
            <div className="space-y-6">
              <fieldset>
                <legend className="text-sm font-semibold">Record packs</legend>
                <p className="mb-2 mt-0.5 text-xs text-muted-foreground">Your industry pack is always installed. Add any others you need.</p>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {packs!.map((p) => {
                    const forced = p.slug === s.industry;
                    const on = forced || s.packs.includes(p.slug) || p.installed;
                    return (
                      <li key={p.slug}>
                        <label className={cn("flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring", on ? "border-primary/50 bg-accent/60" : "border-border", (forced || p.installed) && "cursor-default")}>
                          <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-primary focus-visible:outline-none" checked={on} disabled={forced || p.installed}
                            onChange={(e) => patch({ packs: e.target.checked ? [...s.packs, p.slug] : s.packs.filter((x) => x !== p.slug) })} />
                          <span className="min-w-0">
                            <span className="flex flex-wrap items-center gap-2 font-medium">{p.name}{p.installed && <Pill tone="success">Installed</Pill>}{forced && !p.installed && <Pill tone="info">Your industry</Pill>}</span>
                            <span className="block text-xs text-muted-foreground">{p.description}</span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </fieldset>
              <fieldset>
                <legend className="text-sm font-semibold">Modules</legend>
                <p className="mb-2 mt-0.5 text-xs text-muted-foreground">Turn on what you use today. Everything stays available in the sidebar.</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {MODULES.map((m) => (
                    <Checkbox key={m.key} labelClassName="items-start rounded-lg border border-border p-3 [&>input]:mt-0.5" label={<span><span className="font-medium">{m.label}</span><span className="block text-xs text-muted-foreground">{m.text}</span></span>}
                      checked={s.modules[m.key]} onChange={(e) => patch({ modules: { ...s.modules, [m.key]: e.target.checked } })} />
                  ))}
                </div>
              </fieldset>
            </div>
          )}

          {step === "team" && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">Invite teammates as members now and adjust roles later under Settings → Team. You can skip this step.</p>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                <Field label="Teammate email" error={fieldErrors.invite} className="flex-1">
                  <Input type="email" inputMode="email" autoComplete="off" placeholder="colleague@company.com" value={s.inviteDraft}
                    onChange={(e) => { patch({ inviteDraft: e.target.value }); if (fieldErrors.invite) setFieldErrors((f) => ({ ...f, invite: undefined })); }}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addInvite(); } }} />
                </Field>
                <Button type="button" variant="outline" touch onClick={addInvite} className="sm:mt-5">Add</Button>
              </div>
              {s.invites.length > 0 && (
                <ul className="divide-y divide-border rounded-lg border border-border" aria-label="People to invite">
                  {s.invites.map((email) => (
                    <li key={email} className="flex items-center justify-between gap-3 px-3 py-1.5 text-sm">
                      <span className="min-w-0 break-all">{email}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        {inviteResults[email] === "sent" && <Pill tone="success">Invited</Pill>}
                        {inviteResults[email] === "member" && <Pill tone="info">Already a member</Pill>}
                        {inviteResults[email] === "failed" && <Pill tone="danger">Failed</Pill>}
                        <Button type="button" variant="ghost" size="sm" touch aria-label={`Remove ${email}`} onClick={() => patch({ invites: s.invites.filter((x) => x !== email) })}>Remove</Button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {step === "ai" && (
            <div className="space-y-5">
              <fieldset>
                <legend className="text-sm font-semibold">Default autonomy for new agents</legend>
                <div className="mt-2 grid gap-2">
                  {AUTONOMY.map((a) => (
                    <label key={a.id} className={cn("flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring", s.autonomy === a.id ? "border-primary/50 bg-accent/60" : "border-border")}>
                      <input type="radio" name="autonomy" className="mt-0.5 h-4 w-4 shrink-0 accent-primary focus-visible:outline-none" checked={s.autonomy === a.id} onChange={() => patch({ autonomy: a.id })} />
                      <span><span className="font-medium">{a.label}</span><span className="block text-xs text-muted-foreground">{a.text}</span></span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <Checkbox labelClassName="items-start rounded-lg border border-border p-3 [&>input]:mt-0.5" label={<span><span className="font-medium">Enable recommended playbooks</span><span className="block text-xs text-muted-foreground">Stalled deals, unanswered inbound, overdue work, lead follow-up, social gaps and ticket auto-resolve run on a schedule and queue work for approval.</span></span>}
                checked={s.playbooks} onChange={(e) => patch({ playbooks: e.target.checked })} />
              <Checkbox labelClassName="items-start rounded-lg border border-border p-3 [&>input]:mt-0.5" label={<span><span className="font-medium">Outcome-based pricing</span><span className="block text-xs text-muted-foreground">Off by default. When on, successful agent outcomes consume credits in addition to usage.</span></span>}
                checked={s.outcomePricing} onChange={(e) => patch({ outcomePricing: e.target.checked })} />
            </div>
          )}

          {step === "channels" && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">Connect where your customers reach you. Each link opens the relevant settings page in a new tab; come back here when you&apos;re done, or skip for now.</p>
              <ul className="grid gap-2 sm:grid-cols-2">
                {[
                  { label: "Email notifications", href: "/settings/integrations", on: Boolean(integrations?.email_connected) },
                  { label: "Slack alerts", href: "/settings/integrations", on: Boolean(integrations?.slack_connected) },
                  { label: "SMS and WhatsApp", href: "/settings/integrations", on: Boolean(integrations?.twilio_from_number) },
                  { label: "Mail inbox sync", href: "/settings/mail", on: false },
                  { label: "Social accounts", href: "/social", on: false },
                  { label: "Webhooks and API", href: "/settings/webhooks", on: false },
                ].map((c) => (
                  <li key={c.label}>
                    <Link href={c.href} target="_blank" rel="noreferrer" className="flex min-h-11 items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      <span className="flex items-center gap-1.5 font-medium">
                        {c.label}
                        <ExternalLink className="h-3 w-3 text-muted-foreground" aria-hidden />
                        <span className="sr-only">(opens in a new tab)</span>
                      </span>
                      <Pill tone={c.on ? "success" : "neutral"}>{c.on ? "Connected" : "Set up"}</Pill>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {step === "finish" && (
            <div className="space-y-5">
              <div className="flex items-start gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3" role="status">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
                <div className="text-sm">
                  <p className="font-medium">You&apos;re set up</p>
                  <p className="text-muted-foreground">
                    {finish ? `${finish.packsInstalled.length} pack${finish.packsInstalled.length === 1 ? "" : "s"} installed and ${finish.agentsCreated} starter agent${finish.agentsCreated === 1 ? "" : "s"} created.` : "Setup saved."}
                  </p>
                  {finish && finish.warnings.length > 0 && <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">Some optional steps were skipped: {finish.warnings.join("; ")}</p>}
                </div>
              </div>

              <section aria-labelledby="summary-heading">
                <h3 id="summary-heading" className="text-sm font-semibold">Summary</h3>
                <dl className="mt-2 divide-y divide-border rounded-lg border border-border text-sm">
                  <SummaryRow label="Business" value={`${s.companyName.trim() || "—"} · ${industryName || "—"}`} onEdit={() => goTo("basics")} />
                  <SummaryRow label="Locale" value={`${s.country} · ${s.currency} · ${s.timezone} · ${options!.locales.find((l) => l.code === s.locale)?.label ?? s.locale}`} onEdit={() => goTo("basics")} />
                  <SummaryRow label="Record packs" value={chosenPacks.length ? chosenPacks.map((p) => p.name).join(", ") : "None"} onEdit={() => goTo("modules")} />
                  <SummaryRow label="Modules" value={enabledModules.length ? enabledModules.map((m) => m.label).join(", ") : "None turned on"} onEdit={() => goTo("modules")} />
                  <SummaryRow label="Team" value={s.invites.length ? `${s.invites.length} invite${s.invites.length === 1 ? "" : "s"} sent` : "Just you for now"} onEdit={() => goTo("team")} />
                  <SummaryRow label="AI" value={`${AUTONOMY.find((a) => a.id === s.autonomy)?.label ?? s.autonomy} · playbooks ${s.playbooks ? "on" : "off"} · outcome pricing ${s.outcomePricing ? "on" : "off"}`} onEdit={() => goTo("ai")} />
                </dl>
              </section>

              <div className="grid gap-2 sm:grid-cols-2">
                <button type="button" onClick={() => void seed()} disabled={seeding || seeded}
                  className="flex min-h-11 items-start gap-3 rounded-lg border border-border p-4 text-left hover:bg-secondary/40 disabled:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {seeding ? <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden /> : <Database className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />}
                  <span><span className="block text-sm font-medium">{seeded ? "Sample data loaded" : "Explore with sample data"}</span><span className="block text-xs text-muted-foreground">Realistic contacts, quotes, bookings and tickets for your industry. Remove in one click later.</span></span>
                </button>
                <button type="button" onClick={() => router.push("/home")}
                  className="flex min-h-11 items-start gap-3 rounded-lg border border-border p-4 text-left hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <Rocket className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
                  <span><span className="block text-sm font-medium">Go to my dashboard</span><span className="block text-xs text-muted-foreground">Start with your own data. The setup checklist stays on Home until you finish it.</span></span>
                </button>
              </div>
            </div>
          )}

          <div className="mt-6 flex items-center justify-between gap-3 border-t border-border pt-4">
            <Button type="button" variant="ghost" touch onClick={back} disabled={stepIndex === 0 || saving || step === "finish"}>
              <ArrowLeft className="h-4 w-4" aria-hidden /> Back
            </Button>
            {step !== "finish" ? (
              <Button type="submit" touch disabled={saving}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : null}
                {step === "channels" ? "Finish setup" : step === "team" && s.invites.length === 0 ? "Skip for now" : "Continue"}
                {!saving && <ArrowRight className="h-4 w-4" aria-hidden />}
              </Button>
            ) : (
              <Button type="button" touch onClick={() => router.push("/home")}>
                Open dashboard <ArrowRight className="h-4 w-4" aria-hidden />
              </Button>
            )}
          </div>
        </form>
      )}
    </PageContainer>
  );
}

function SummaryRow({ label, value, onEdit }: { label: string; value: string; onEdit: () => void }) {
  return (
    <div className="flex items-start gap-3 px-3 py-2">
      <dt className="w-24 shrink-0 pt-0.5 text-xs font-medium text-muted-foreground sm:w-28">{label}</dt>
      <dd className="min-w-0 flex-1 break-words">{value}</dd>
      <Button type="button" variant="ghost" size="sm" touch onClick={onEdit} aria-label={`Change ${label.toLowerCase()}`}>
        <Pencil className="h-3.5 w-3.5" aria-hidden /> <span className="hidden sm:inline">Change</span>
      </Button>
    </div>
  );
}
