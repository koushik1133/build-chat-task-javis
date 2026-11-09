"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Bot, Building2, CheckCircle2, Database, Loader2, Plug, Rocket, Users, Wrench } from "lucide-react";
import { PageContainer } from "@/components/page-container";
import { Button } from "@/components/ui/button";
import { Banner, Loading } from "@/components/ui/feedback";
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

interface WizardState {
  companyName: string;
  industry: string;
  country: string;
  currency: string;
  timezone: string;
  locale: string;
  packs: string[];
  modules: { booking: boolean; invoicing: boolean; helpdesk: boolean; inventory: boolean; voice_mail: boolean };
  invites: string[];
  inviteDraft: string;
  autonomy: Autonomy;
  playbooks: boolean;
  outcomePricing: boolean;
}

const STEPS = [
  { id: "basics", label: "Your business", icon: Building2 },
  { id: "modules", label: "What you do", icon: Wrench },
  { id: "team", label: "Team", icon: Users },
  { id: "ai", label: "AI preferences", icon: Bot },
  { id: "channels", label: "Channels", icon: Plug },
  { id: "finish", label: "Finish", icon: Rocket },
] as const;
type StepId = (typeof STEPS)[number]["id"];

const COUNTRIES = ["United States", "United Kingdom", "Canada", "Australia", "India", "Germany", "France", "Spain", "Mexico", "Brazil", "Singapore", "United Arab Emirates", "Other"];

const AUTONOMY: Array<{ id: Autonomy; label: string; text: string }> = [
  { id: "draft", label: "Draft only", text: "Agents prepare work; you send and save everything yourself." },
  { id: "approve", label: "Ask before acting", text: "Agents do the work and pause for approval on anything external. Recommended." },
  { id: "auto", label: "Autonomous", text: "Agents act within their tool allowlist without waiting. Best once you trust the playbooks." },
];

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
  const [inviteResults, setInviteResults] = useState<Record<string, "sent" | "member" | "failed">>({});
  const [finish, setFinish] = useState<{ packsInstalled: string[]; agentsCreated: number; warnings: string[] } | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [seeded, setSeeded] = useState(false);

  const [s, setS] = useState<WizardState>({
    companyName: "",
    industry: "",
    country: "United States",
    currency: "USD",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
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
        setS((prev) => ({ ...prev, currency: o.settings.currency ?? prev.currency, timezone: o.settings.timezone ?? prev.timezone, locale: o.settings.locale ?? prev.locale }));
      } else {
        setOptions({ settings: { locale: "en", currency: "USD", timezone: "UTC" }, locales: [{ code: "en", label: "English" }], currencies: [{ code: "USD", symbol: "$", name: "US Dollar" }] });
      }
      setIntegrations((i?.integrations as IntegrationsView | undefined) ?? {});
    })();
    return () => ac.abort();
  }, []);

  const tzList = useMemo(timezones, []);
  const stepIndex = STEPS.findIndex((x) => x.id === step);

  const saveBasics = useCallback(async () => {
    if (!s.companyName.trim()) throw new Error("Give your business a name.");
    if (!s.industry) throw new Error("Pick the industry closest to what you do.");
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
  const back = () => { setError(null); setStep(STEPS[Math.max(0, stepIndex - 1)].id); };

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
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { setError("Enter a valid email address."); return; }
    if (s.invites.includes(v)) { patch({ inviteDraft: "" }); return; }
    setError(null);
    patch({ invites: [...s.invites, v], inviteDraft: "" });
  };

  const loading = packs === null || options === null;

  return (
    <PageContainer title="Set up your workspace" description="Six short steps. You can change any of this later in Settings." icon={<Rocket className="h-5 w-5" />}>
      <ol className="mb-6 flex flex-wrap gap-2" aria-label="Setup steps">
        {STEPS.map((st, i) => {
          const Icon = st.icon;
          const state = i < stepIndex ? "done" : i === stepIndex ? "current" : "todo";
          return (
            <li key={st.id} aria-current={state === "current" ? "step" : undefined}
              className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs", state === "current" && "border-primary bg-primary/10 text-primary", state === "done" && "border-emerald-500/40 text-emerald-700 dark:text-emerald-300", state === "todo" && "border-border text-muted-foreground")}>
              {state === "done" ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> : <Icon className="h-3.5 w-3.5" aria-hidden />}
              <span className="hidden sm:inline">{st.label}</span>
              <span className="sm:hidden">{i + 1}</span>
            </li>
          );
        })}
      </ol>

      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}
      {loading && <Loading label="Loading your workspace…" />}

      {!loading && (
        <div className="rounded-xl border border-border bg-card p-4 sm:p-6">
          {step === "basics" && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Business name" required className="sm:col-span-2">
                <Input value={s.companyName} onChange={(e) => patch({ companyName: e.target.value })} placeholder="e.g. Northwind Studio" maxLength={80} autoFocus />
              </Field>
              <Field label="Industry" required hint="Picks your starter record types and agents." className="sm:col-span-2">
                <Select value={s.industry} onChange={(e) => patch({ industry: e.target.value })}>
                  <option value="">Choose an industry…</option>
                  {packs!.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
                </Select>
              </Field>
              <Field label="Country">
                <Select value={s.country} onChange={(e) => patch({ country: e.target.value })}>
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
            <div className="space-y-5">
              <div>
                <h2 className="text-sm font-semibold">Record packs</h2>
                <p className="mb-2 text-xs text-muted-foreground">Your industry pack is always installed. Add any others you need.</p>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {packs!.map((p) => {
                    const forced = p.slug === s.industry;
                    const on = forced || s.packs.includes(p.slug) || p.installed;
                    return (
                      <li key={p.slug}>
                        <label className={cn("flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm", on ? "border-primary/50 bg-primary/5" : "border-border")}>
                          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={on} disabled={forced || p.installed}
                            onChange={(e) => patch({ packs: e.target.checked ? [...s.packs, p.slug] : s.packs.filter((x) => x !== p.slug) })} />
                          <span className="min-w-0">
                            <span className="flex items-center gap-2 font-medium">{p.name}{p.installed && <Pill tone="success">installed</Pill>}{forced && !p.installed && <Pill tone="info">your industry</Pill>}</span>
                            <span className="block text-xs text-muted-foreground">{p.description}</span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
              <div>
                <h2 className="text-sm font-semibold">Modules</h2>
                <p className="mb-2 text-xs text-muted-foreground">Turn on what you use today. Everything stays available in the sidebar.</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {([
                    ["booking", "Online booking", "A public booking page with a default calendar and an intro-call type."],
                    ["invoicing", "Quotes & invoicing", "Send quotes, convert accepted ones to invoices, take payments."],
                    ["helpdesk", "Helpdesk & SLAs", "Tickets from email, chat and portal with a standard SLA policy."],
                    ["inventory", "Inventory & stock", "Products with stock levels, reorder points and equipment checkouts."],
                    ["voice_mail", "Voice & mail campaigns", "Outbound calls and synced inbox for follow-ups."],
                  ] as const).map(([key, label, text]) => (
                    <Checkbox key={key} label={<span><span className="font-medium">{label}</span><span className="block text-xs text-muted-foreground">{text}</span></span>}
                      checked={s.modules[key]} onChange={(e) => patch({ modules: { ...s.modules, [key]: e.target.checked } })} />
                  ))}
                </div>
              </div>
            </div>
          )}

          {step === "team" && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">Invite teammates as members now; adjust roles later under Settings → Team. You can skip this step.</p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input type="email" placeholder="colleague@company.com" value={s.inviteDraft} onChange={(e) => patch({ inviteDraft: e.target.value })}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addInvite(); } }} aria-label="Teammate email" />
                <Button type="button" variant="outline" onClick={addInvite}>Add</Button>
              </div>
              {s.invites.length > 0 && (
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {s.invites.map((email) => (
                    <li key={email} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                      <span className="truncate">{email}</span>
                      <span className="flex items-center gap-2">
                        {inviteResults[email] === "sent" && <Pill tone="success">invited</Pill>}
                        {inviteResults[email] === "member" && <Pill tone="info">already a member</Pill>}
                        {inviteResults[email] === "failed" && <Pill tone="danger">failed</Pill>}
                        <button type="button" className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => patch({ invites: s.invites.filter((x) => x !== email) })}>Remove</button>
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
                    <label key={a.id} className={cn("flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm", s.autonomy === a.id ? "border-primary/50 bg-primary/5" : "border-border")}>
                      <input type="radio" name="autonomy" className="mt-0.5 h-4 w-4" checked={s.autonomy === a.id} onChange={() => patch({ autonomy: a.id })} />
                      <span><span className="font-medium">{a.label}</span><span className="block text-xs text-muted-foreground">{a.text}</span></span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <Checkbox label={<span><span className="font-medium">Enable recommended playbooks</span><span className="block text-xs text-muted-foreground">Stalled deals, unanswered inbound, overdue work, lead follow-up, social gaps and ticket auto-resolve run on a schedule and queue work for approval.</span></span>}
                checked={s.playbooks} onChange={(e) => patch({ playbooks: e.target.checked })} />
              <Checkbox label={<span><span className="font-medium">Outcome-based pricing</span><span className="block text-xs text-muted-foreground">Off by default. When on, successful agent outcomes consume credits in addition to usage.</span></span>}
                checked={s.outcomePricing} onChange={(e) => patch({ outcomePricing: e.target.checked })} />
            </div>
          )}

          {step === "channels" && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">Connect where your customers reach you. Each link opens the relevant settings page; come back here when you&apos;re done, or skip for now.</p>
              <ul className="grid gap-2 sm:grid-cols-2">
                {[
                  { label: "Email notifications", href: "/settings/integrations", on: Boolean(integrations?.email_connected) },
                  { label: "Slack alerts", href: "/settings/integrations", on: Boolean(integrations?.slack_connected) },
                  { label: "SMS / WhatsApp", href: "/settings/integrations", on: Boolean(integrations?.twilio_from_number) },
                  { label: "Mail inbox sync", href: "/settings/mail", on: false },
                  { label: "Social accounts", href: "/social", on: false },
                  { label: "Webhooks & API", href: "/settings/webhooks", on: false },
                ].map((c) => (
                  <li key={c.label}>
                    <Link href={c.href} target="_blank" rel="noreferrer" className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      <span className="font-medium">{c.label}</span>
                      <Pill tone={c.on ? "success" : "neutral"}>{c.on ? "connected" : "set up"}</Pill>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {step === "finish" && (
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 h-6 w-6 text-emerald-600" aria-hidden />
                <div>
                  <h2 className="text-base font-semibold">You&apos;re set up</h2>
                  <p className="text-sm text-muted-foreground">
                    {finish ? `${finish.packsInstalled.length} pack${finish.packsInstalled.length === 1 ? "" : "s"} installed, ${finish.agentsCreated} starter agent${finish.agentsCreated === 1 ? "" : "s"} created.` : "Setup saved."}
                    {finish && finish.warnings.length > 0 && <span className="block text-xs text-amber-700 dark:text-amber-300">Some optional steps were skipped: {finish.warnings.join("; ")}</span>}
                  </p>
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <button type="button" onClick={() => void seed()} disabled={seeding || seeded}
                  className="flex items-start gap-3 rounded-lg border border-border p-4 text-left hover:bg-secondary/40 disabled:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {seeding ? <Loader2 className="mt-0.5 h-5 w-5 animate-spin" aria-hidden /> : <Database className="mt-0.5 h-5 w-5 text-primary" aria-hidden />}
                  <span><span className="block text-sm font-medium">{seeded ? "Sample data loaded" : "Explore with sample data"}</span><span className="block text-xs text-muted-foreground">Realistic contacts, quotes, bookings and tickets for your industry. Remove in one click later.</span></span>
                </button>
                <button type="button" onClick={() => router.push("/home")}
                  className="flex items-start gap-3 rounded-lg border border-border p-4 text-left hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <Rocket className="mt-0.5 h-5 w-5 text-primary" aria-hidden />
                  <span><span className="block text-sm font-medium">Go to my dashboard</span><span className="block text-xs text-muted-foreground">Start with your own data. The setup checklist stays on Home until you finish it.</span></span>
                </button>
              </div>
            </div>
          )}

          <div className="mt-6 flex items-center justify-between gap-3 border-t border-border pt-4">
            <Button type="button" variant="ghost" onClick={back} disabled={stepIndex === 0 || saving || step === "finish"}>
              <ArrowLeft className="mr-1.5 h-4 w-4" aria-hidden /> Back
            </Button>
            {step !== "finish" ? (
              <Button type="button" onClick={() => void next()} disabled={saving}>
                {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : null}
                {step === "channels" ? "Finish setup" : step === "team" && s.invites.length === 0 ? "Skip" : "Continue"}
                {!saving && <ArrowRight className="ml-1.5 h-4 w-4" aria-hidden />}
              </Button>
            ) : (
              <Button type="button" onClick={() => router.push("/home")}>Open dashboard</Button>
            )}
          </div>
        </div>
      )}
    </PageContainer>
  );
}
