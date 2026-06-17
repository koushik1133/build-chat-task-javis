"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, ChevronRight, ChevronLeft, Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { KERNELHUB_TAGLINE } from "@/lib/brand";

const INDUSTRIES = [
  "SaaS / Software", "E-commerce / Retail", "Agency / Consulting",
  "Healthcare / MedTech", "Real Estate", "Finance / FinTech",
  "Education / EdTech", "Media / Content", "Manufacturing",
  "Legal / Professional Services", "Non-profit", "Other",
];
const STAGES = [
  { value: "pre-revenue", label: "Pre-revenue", desc: "Idea / validation stage" },
  { value: "early", label: "Early Stage", desc: "First customers, <$100k ARR" },
  { value: "growth", label: "Growth", desc: "$100k–$1M ARR" },
  { value: "scale", label: "Scale-up", desc: "$1M–$10M ARR" },
  { value: "enterprise", label: "Enterprise", desc: "$10M+ ARR" },
];
const TEAM_SIZES = ["Just me", "2–5", "6–15", "16–50", "51–200", "200+"];
const CHALLENGES = [
  { value: "leads", label: "Generating more leads", icon: "🎯" },
  { value: "ops", label: "Operational efficiency", icon: "⚙️" },
  { value: "content", label: "Content & marketing", icon: "✍️" },
  { value: "strategy", label: "Business strategy", icon: "🧭" },
  { value: "engineering", label: "Engineering velocity", icon: "⚡" },
  { value: "hiring", label: "Hiring & team growth", icon: "👥" },
];
const MODULES = [
  { key: "chat", label: "AI Chat & RAG", desc: "Chat with your files and data", icon: "💬" },
  { key: "strategy", label: "Strategy Hub", desc: "AI business strategy documents", icon: "🧭" },
  { key: "production", label: "Production Kanban", desc: "Customizable ops board", icon: "📋" },
  { key: "agents", label: "AI Agents", desc: "Autonomous workforce", icon: "🤖" },
  { key: "automations", label: "Automations", desc: "Self-healing pipelines", icon: "⚡" },
  { key: "build", label: "AI Site Builder", desc: "Generate production websites", icon: "🏗️" },
  { key: "github", label: "GitHub Review", desc: "AI code reviews & READMEs", icon: "🐙" },
  { key: "analytics", label: "Data Analysis", desc: "BI dashboard & ROI tracking", icon: "📊" },
];

type Form = {
  company_name: string;
  industry: string;
  stage: string;
  team_size: string;
  geography: string;
  product_desc: string;
  target_market: string;
  challenge: string;
  revenue_range: string;
  modules: string[];
};

const EMPTY: Form = {
  company_name: "", industry: "", stage: "", team_size: "",
  geography: "", product_desc: "", target_market: "", challenge: "",
  revenue_range: "", modules: ["chat", "strategy", "production"],
};

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<Form>(EMPTY);
  const [saving, setSaving] = useState(false);

  function set<K extends keyof Form>(k: K, v: Form[K]) {
    setForm(f => ({ ...f, [k]: v }));
  }

  function toggleModule(key: string) {
    setForm(f => ({
      ...f,
      modules: f.modules.includes(key)
        ? f.modules.filter(m => m !== key)
        : [...f.modules, key],
    }));
  }

  async function finish() {
    setSaving(true);
    try {
      const res = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console.error("Onboarding save failed:", res.status, data);
        setSaving(false);
        alert(`Could not save your profile (${res.status}). Please try again.`);
        return;
      }
    } catch (err) {
      console.error("Onboarding network error:", err);
      setSaving(false);
      alert("Network error — make sure the dev server is running and try again.");
      return;
    }

    // Fire-and-forget strategy seeding — don't block navigation
    if (form.modules.includes("strategy")) {
      fetch("/api/strategy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "competitor",
          title: `${form.company_name} — Competitive Analysis`,
        }),
      }).catch(() => {});
    }

    router.push("/chat");
  }

  const canNext = [
    form.company_name.trim() && form.industry && form.stage && form.team_size,
    form.product_desc.trim() && form.challenge,
    form.modules.length > 0,
  ][step];

  const steps = ["Company Profile", "Business Context", "Your Workspace"];

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="w-full max-w-xl">
        {/* Brand */}
        <div className="mb-8 flex flex-col items-center gap-1.5 text-center">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15">
              <Sparkles className="h-4 w-4 text-primary" />
            </div>
            <span className="font-semibold tracking-tight">
              Kernel<span className="text-primary">Hub</span>
            </span>
          </div>
          <p className="max-w-sm text-xs text-muted-foreground">{KERNELHUB_TAGLINE}</p>
        </div>

        {/* Progress */}
        <div className="flex items-center gap-2 mb-8">
          {steps.map((s, i) => (
            <div key={s} className="flex items-center gap-2 flex-1">
              <div className={cn(
                "h-6 w-6 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 transition-colors",
                i < step ? "bg-primary text-primary-foreground"
                : i === step ? "bg-primary text-primary-foreground"
                : "bg-secondary text-muted-foreground"
              )}>
                {i < step ? <Check className="h-3 w-3" /> : i + 1}
              </div>
              <span className={cn("text-xs hidden sm:block", i === step ? "text-foreground font-medium" : "text-muted-foreground")}>{s}</span>
              {i < steps.length - 1 && <div className={cn("flex-1 h-px", i < step ? "bg-primary" : "bg-border")} />}
            </div>
          ))}
        </div>

        {/* Card */}
        <div className="rounded-2xl border border-border bg-card p-8 shadow-sm">
          {step === 0 && (
            <div className="space-y-5">
              <div>
                <h1 className="text-xl font-semibold">Tell us about your company</h1>
                <p className="text-sm text-muted-foreground mt-1">This shapes your entire workspace — strategies, templates, and AI context.</p>
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1.5">Company name *</label>
                <input value={form.company_name} onChange={e => set("company_name", e.target.value)}
                  placeholder="Acme Corp"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/30" />
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-2">Industry *</label>
                <div className="grid grid-cols-2 gap-2">
                  {INDUSTRIES.map(ind => (
                    <button key={ind} onClick={() => set("industry", ind)}
                      className={cn("rounded-lg border px-3 py-2 text-xs text-left transition-colors",
                        form.industry === ind ? "border-primary bg-primary/10 text-primary font-medium" : "border-border bg-background hover:border-primary/40"
                      )}>
                      {ind}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-2">Company stage *</label>
                <div className="space-y-2">
                  {STAGES.map(s => (
                    <button key={s.value} onClick={() => set("stage", s.value)}
                      className={cn("w-full rounded-lg border px-4 py-2.5 flex items-center justify-between transition-colors",
                        form.stage === s.value ? "border-primary bg-primary/10" : "border-border bg-background hover:border-primary/40"
                      )}>
                      <span className={cn("text-sm font-medium", form.stage === s.value ? "text-primary" : "")}>{s.label}</span>
                      <span className="text-xs text-muted-foreground">{s.desc}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-2">Team size *</label>
                <div className="flex gap-2 flex-wrap">
                  {TEAM_SIZES.map(t => (
                    <button key={t} onClick={() => set("team_size", t)}
                      className={cn("rounded-lg border px-3 py-1.5 text-xs transition-colors",
                        form.team_size === t ? "border-primary bg-primary/10 text-primary font-medium" : "border-border bg-background hover:border-primary/40"
                      )}>
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1.5">Primary geography</label>
                <input value={form.geography} onChange={e => set("geography", e.target.value)}
                  placeholder="e.g. North America, Global, Europe"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-5">
              <div>
                <h1 className="text-xl font-semibold">What does your business do?</h1>
                <p className="text-sm text-muted-foreground mt-1">KernelHub uses this to generate deeply relevant strategies and insights.</p>
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1.5">What do you sell / what is your product? *</label>
                <textarea value={form.product_desc} onChange={e => set("product_desc", e.target.value)}
                  placeholder="e.g. We build B2B SaaS tools for project management targeting mid-market companies..."
                  className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/30 min-h-[90px] resize-none" />
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1.5">Who is your target customer?</label>
                <input value={form.target_market} onChange={e => set("target_market", e.target.value)}
                  placeholder="e.g. B2B mid-market, CTOs at 50–500 person companies"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/30" />
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-2">Biggest challenge right now *</label>
                <div className="grid grid-cols-2 gap-2">
                  {CHALLENGES.map(c => (
                    <button key={c.value} onClick={() => set("challenge", c.value)}
                      className={cn("rounded-lg border px-3 py-2.5 flex items-center gap-2 text-left transition-colors",
                        form.challenge === c.value ? "border-primary bg-primary/10" : "border-border bg-background hover:border-primary/40"
                      )}>
                      <span className="text-base">{c.icon}</span>
                      <span className={cn("text-xs font-medium", form.challenge === c.value ? "text-primary" : "")}>{c.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1.5">Monthly revenue range (optional)</label>
                <select value={form.revenue_range} onChange={e => set("revenue_range", e.target.value)}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/30">
                  <option value="">Prefer not to say</option>
                  <option>Pre-revenue</option>
                  <option>$0 – $10k/mo</option>
                  <option>$10k – $50k/mo</option>
                  <option>$50k – $100k/mo</option>
                  <option>$100k – $500k/mo</option>
                  <option>$500k+/mo</option>
                </select>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-5">
              <div>
                <h1 className="text-xl font-semibold">Configure your workspace</h1>
                <p className="text-sm text-muted-foreground mt-1">Choose the modules you need. You can always change this later.</p>
              </div>

              <div className="grid grid-cols-1 gap-2">
                {MODULES.map(m => {
                  const on = form.modules.includes(m.key);
                  return (
                    <button key={m.key} onClick={() => toggleModule(m.key)}
                      className={cn("rounded-xl border px-4 py-3 flex items-center gap-3 text-left transition-all",
                        on ? "border-primary bg-primary/8" : "border-border bg-background hover:border-primary/30"
                      )}>
                      <span className="text-lg shrink-0">{m.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className={cn("text-sm font-medium", on ? "text-primary" : "")}>{m.label}</div>
                        <div className="text-xs text-muted-foreground">{m.desc}</div>
                      </div>
                      <div className={cn("h-5 w-5 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors",
                        on ? "border-primary bg-primary" : "border-border"
                      )}>
                        {on && <Check className="h-2.5 w-2.5 text-white" />}
                      </div>
                    </button>
                  );
                })}
              </div>

              <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
                <p className="text-xs text-muted-foreground">
                  Based on your profile, KernelHub will pre-generate a <strong className="text-foreground">{form.industry || "industry"}-specific</strong> strategy framework,
                  configure your Production board with the right template for a <strong className="text-foreground">{form.stage || "your stage"}</strong> company,
                  and prime your AI context with your product description.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Nav */}
        <div className="flex items-center justify-between mt-4">
          <button
            onClick={() => setStep(s => s - 1)}
            disabled={step === 0}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronLeft className="h-4 w-4" /> Back
          </button>

          <div className="flex items-center gap-3">
            {/* Always allow skipping so users are never stuck */}
            <button
              onClick={() => router.push("/chat")}
              className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
            >
              Skip for now
            </button>

            {step < 2 ? (
              <button
                onClick={() => setStep(s => s + 1)}
                disabled={!canNext}
                className="flex items-center gap-1.5 bg-primary text-primary-foreground rounded-lg px-5 py-2.5 text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:bg-primary/90 transition-colors"
              >
                Continue <ChevronRight className="h-4 w-4" />
              </button>
            ) : (
              <button
                onClick={finish}
                disabled={!canNext || saving}
                className="flex items-center gap-1.5 bg-primary text-primary-foreground rounded-lg px-5 py-2.5 text-sm font-semibold disabled:opacity-40 hover:bg-primary/90 transition-colors"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {saving ? "Setting up your workspace..." : "Launch KernelHub"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
