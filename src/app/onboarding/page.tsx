"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Sparkles, ChevronRight, ChevronLeft, Check, Loader2,
  Heart, GraduationCap, Scale, DollarSign, Home, ShoppingBag,
  HandHeart, Rocket, Building2, Briefcase, Lightbulb, Send,
} from "lucide-react";
import { KERNELHUB_NAME } from "@/lib/brand";
import { cn } from "@/lib/utils";

// ─── Domain Definitions ──────────────────────────────────────────────────────

const DOMAINS = [
  {
    key: "agency",
    label: "Agency / Consultancy",
    desc: "Software firms, design agencies, consulting",
    icon: Building2,
    color: "text-slate-600 dark:text-slate-400",
    bg: "bg-slate-50 border-slate-200 dark:bg-slate-950 dark:border-slate-800",
    active: "border-slate-600 bg-slate-50 dark:bg-slate-950",
    features: ["agency", "proposals", "standups", "slack_bot", "github", "ai_agents"],
  },
  {
    key: "healthcare",
    label: "Healthcare",
    desc: "Clinics, hospitals, health startups, telehealth",
    icon: Heart,
    color: "text-rose-600 dark:text-rose-400",
    bg: "bg-rose-50 border-rose-200 dark:bg-rose-950 dark:border-rose-900",
    active: "border-rose-500 bg-rose-50 dark:bg-rose-950",
    features: ["patient_intake", "soap_notes", "hipaa_checker", "health_analytics", "crm", "automations"],
  },
  {
    key: "education",
    label: "Education / Students",
    desc: "EdTech, tutors, students, schools, universities",
    icon: GraduationCap,
    color: "text-indigo-600 dark:text-indigo-400",
    bg: "bg-indigo-50 border-indigo-200 dark:bg-indigo-950 dark:border-indigo-900",
    active: "border-indigo-500 bg-indigo-50 dark:bg-indigo-950",
    features: ["study_planner", "research_assistant", "assignment_grader", "quiz_generator", "chat", "files"],
  },
  {
    key: "legal",
    label: "Legal",
    desc: "Law firms, attorneys, legal tech, compliance",
    icon: Scale,
    color: "text-slate-700 dark:text-slate-300",
    bg: "bg-slate-50 border-slate-200 dark:bg-slate-950 dark:border-slate-800",
    active: "border-slate-600 bg-slate-50 dark:bg-slate-950",
    features: ["contract_analyzer", "legal_research", "case_files", "billing_logger", "crm", "documents"],
  },
  {
    key: "finance",
    label: "Finance / FinTech",
    desc: "Financial advisors, traders, FinTech startups",
    icon: DollarSign,
    color: "text-emerald-600 dark:text-emerald-400",
    bg: "bg-emerald-50 border-emerald-200 dark:bg-emerald-950 dark:border-emerald-900",
    active: "border-emerald-500 bg-emerald-50 dark:bg-emerald-950",
    features: ["portfolio_tracker", "financial_reports", "risk_dashboard", "budget_forecast", "crm", "analytics"],
  },
  {
    key: "realestate",
    label: "Real Estate",
    desc: "Agents, brokers, investors, proptech platforms",
    icon: Home,
    color: "text-amber-600 dark:text-amber-400",
    bg: "bg-amber-50 border-amber-200 dark:bg-amber-950 dark:border-amber-900",
    active: "border-amber-500 bg-amber-50 dark:bg-amber-950",
    features: ["property_listings", "listing_generator", "market_analysis", "investment_calculator", "crm", "leads"],
  },
  {
    key: "ecommerce",
    label: "E-commerce / Retail",
    desc: "Shopify brands, DTC, retail, marketplace sellers",
    icon: ShoppingBag,
    color: "text-violet-600 dark:text-violet-400",
    bg: "bg-violet-50 border-violet-200 dark:bg-violet-950 dark:border-violet-900",
    active: "border-violet-500 bg-violet-50 dark:bg-violet-950",
    features: ["product_descriptions", "review_analyzer", "ad_copy_generator", "inventory_monitor", "crm", "analytics"],
  },
  {
    key: "nonprofit",
    label: "Non-profit",
    desc: "NGOs, charities, foundations, social impact orgs",
    icon: HandHeart,
    color: "text-rose-600 dark:text-rose-400",
    bg: "bg-rose-50 border-rose-200 dark:bg-rose-950 dark:border-rose-900",
    active: "border-rose-500 bg-rose-50 dark:bg-rose-950",
    features: ["grant_proposals", "donor_crm", "impact_reports", "donor_retention", "automations", "social_media"],
  },
  {
    key: "business",
    label: "Business / Startup",
    desc: "Founders, SaaS companies, SMBs, startups",
    icon: Rocket,
    color: "text-violet-600 dark:text-violet-400",
    bg: "bg-violet-50 border-violet-200 dark:bg-violet-950 dark:border-violet-900",
    active: "border-violet-500 bg-violet-50 dark:bg-violet-950",
    features: ["pitch_deck_ai", "investor_crm", "gtm_strategy", "burn_rate", "strategy", "analytics"],
  },
];

// ─── Feature Definitions per domain ──────────────────────────────────────────

const FEATURE_CATALOG: Record<string, { key: string; label: string; desc: string; icon: string }[]> = {
  agency: [
    { key: "agency", label: "Agency Command Center", desc: "Client projects, proposals, employee standups", icon: "🏢" },
    { key: "proposals", label: "AI Proposal Generator", desc: "AI-generated technical specs & milestones", icon: "📋" },
    { key: "standups", label: "Daily Standups", desc: "Track blockers and developer progress", icon: "✅" },
    { key: "slack_bot", label: "Slack Agency Bot", desc: "Query team status via Slack commands", icon: "💬" },
    { key: "github", label: "GitHub Review", desc: "AI code reviews and README generation", icon: "🐙" },
    { key: "ai_agents", label: "AI Agent Swarms", desc: "Autonomous multi-agent task execution", icon: "🤖" },
    { key: "crm", label: "CRM", desc: "Universal contact management", icon: "👥" },
    { key: "strategy", label: "Strategy Hub", desc: "Business strategy documents", icon: "🧭" },
  ],
  healthcare: [
    { key: "patient_intake", label: "Patient Intake AI", desc: "Auto-generate clinical summaries from intake", icon: "🏥" },
    { key: "soap_notes", label: "SOAP Note Converter", desc: "Turn clinical notes into structured SOAP format", icon: "📋" },
    { key: "hipaa_checker", label: "HIPAA Compliance", desc: "Detect PHI and HIPAA violations in text", icon: "🔒" },
    { key: "health_analytics", label: "Health Analytics", desc: "AI practice insights from patient data", icon: "📊" },
    { key: "crm", label: "Patient CRM", desc: "Track patient contacts and lifecycle", icon: "👥" },
    { key: "automations", label: "Automations", desc: "Appointment reminders and follow-ups", icon: "⚡" },
  ],
  education: [
    { key: "study_planner", label: "AI Study Planner", desc: "Generate weekly study schedules per subject", icon: "📚" },
    { key: "research_assistant", label: "Research Assistant", desc: "Summarize topics into structured research notes", icon: "🔬" },
    { key: "assignment_grader", label: "Assignment Grader", desc: "AI grading with detailed feedback", icon: "✏️" },
    { key: "quiz_generator", label: "Quiz Generator", desc: "Generate interactive multiple-choice quizzes", icon: "🎯" },
    { key: "chat", label: "AI Chat", desc: "Chat with your study materials", icon: "💬" },
    { key: "files", label: "Document RAG", desc: "Upload and query textbooks and notes", icon: "📂" },
  ],
  legal: [
    { key: "contract_analyzer", label: "Contract Analyzer", desc: "AI identifies risks, red flags, missing clauses", icon: "📜" },
    { key: "legal_research", label: "Legal Research AI", desc: "Query legal topics with jurisdiction context", icon: "⚖️" },
    { key: "case_files", label: "Case File Manager", desc: "Organize cases with timeline and billing log", icon: "🗂️" },
    { key: "billing_logger", label: "Billing Logger", desc: "Track hours, rates, and case revenue", icon: "💰" },
    { key: "crm", label: "Client CRM", desc: "Manage legal clients and contacts", icon: "👥" },
    { key: "documents", label: "Document Builder", desc: "AI-generated legal document templates", icon: "📄" },
  ],
  finance: [
    { key: "portfolio_tracker", label: "Portfolio Tracker", desc: "Track assets with P&L analysis", icon: "📈" },
    { key: "financial_reports", label: "Financial Reports AI", desc: "AI-generated P&L narratives and KPI commentary", icon: "📊" },
    { key: "risk_dashboard", label: "Risk Dashboard", desc: "AI risk scoring with mitigation steps", icon: "⚠️" },
    { key: "budget_forecast", label: "Budget Forecast", desc: "AI 12-month financial projections", icon: "🔮" },
    { key: "crm", label: "Client CRM", desc: "Manage investor and client relationships", icon: "👥" },
    { key: "analytics", label: "Data Analysis", desc: "BI dashboard and chart generation", icon: "📉" },
  ],
  realestate: [
    { key: "property_listings", label: "Property Listings", desc: "Manage and track property portfolio", icon: "🏠" },
    { key: "listing_generator", label: "AI Listing Writer", desc: "Compelling property descriptions with SEO", icon: "✍️" },
    { key: "market_analysis", label: "Market Analysis", desc: "AI-powered local market reports", icon: "📊" },
    { key: "investment_calculator", label: "Investment Analyzer", desc: "ROI, cap rate, cash flow calculations", icon: "💰" },
    { key: "crm", label: "Lead CRM", desc: "Track buyer and seller leads", icon: "👥" },
    { key: "leads", label: "Lead Inbox", desc: "Centralize inbound inquiry leads", icon: "📧" },
  ],
  ecommerce: [
    { key: "product_descriptions", label: "Product Description AI", desc: "SEO-optimized product copy + 3 variations", icon: "🛍️" },
    { key: "review_analyzer", label: "Review Analyzer", desc: "Extract insights from customer reviews", icon: "⭐" },
    { key: "ad_copy_generator", label: "Ad Copy Generator", desc: "Platform-specific ad copy (FB, Google, TikTok)", icon: "📣" },
    { key: "inventory_monitor", label: "Inventory Monitor", desc: "Low stock alerts and product tracking", icon: "📦" },
    { key: "crm", label: "Customer CRM", desc: "Manage customer contacts and segments", icon: "👥" },
    { key: "analytics", label: "Sales Analytics", desc: "Revenue trends and product performance", icon: "📈" },
  ],
  nonprofit: [
    { key: "grant_proposals", label: "Grant Proposal AI", desc: "Full grant proposals with SMART outcomes", icon: "📝" },
    { key: "donor_crm", label: "Donor CRM", desc: "Track donors, donations, and engagement", icon: "❤️" },
    { key: "impact_reports", label: "Impact Report Generator", desc: "Compelling annual impact narratives", icon: "📊" },
    { key: "donor_retention", label: "Donor Retention AI", desc: "Re-engage lapsed donors with personalized tips", icon: "🔄" },
    { key: "automations", label: "Automations", desc: "Donor thank-you and follow-up sequences", icon: "⚡" },
    { key: "social_media", label: "Social Media AI", desc: "Mission-driven content creation", icon: "📱" },
  ],
  business: [
    { key: "pitch_deck_ai", label: "Pitch Deck AI", desc: "12-slide investor-ready pitch deck outline", icon: "🚀" },
    { key: "investor_crm", label: "Investor CRM", desc: "Track investors from contact to term sheet", icon: "💼" },
    { key: "gtm_strategy", label: "GTM Strategy", desc: "30/60/90 day go-to-market plan with channel ranking", icon: "🎯" },
    { key: "burn_rate", label: "Burn Rate Analyzer", desc: "Runway, net burn, and AI financial optimization", icon: "📉" },
    { key: "strategy", label: "Strategy Hub", desc: "AI business strategy documents", icon: "🧭" },
    { key: "analytics", label: "Analytics Dashboard", desc: "KPI tracking and BI charts", icon: "📊" },
  ],
};

// ─── Core Modules (always available) ─────────────────────────────────────────

const CORE_MODULES = [
  { key: "chat", label: "AI Chat & RAG", desc: "Chat with your files and data", icon: "💬" },
  { key: "ai_agents", label: "AI Agents", desc: "Autonomous AI workforce", icon: "🤖" },
  { key: "automations", label: "Automations", desc: "Self-healing workflow pipelines", icon: "⚡" },
  { key: "build", label: "AI Site Builder", desc: "Generate production websites", icon: "🏗️" },
  { key: "social_media", label: "Social Media AI", desc: "Content creation & scheduling", icon: "📱" },
  { key: "analytics", label: "Data Analysis", desc: "BI dashboards and ROI tracking", icon: "📊" },
  { key: "strategy", label: "Strategy Hub", desc: "AI business strategy documents", icon: "🧭" },
  { key: "production", label: "Production Kanban", desc: "Customizable ops board", icon: "📋" },
];

// ─── Form types ───────────────────────────────────────────────────────────────

type Form = {
  company_name: string;
  domain: string;
  industry: string;
  stage: string;
  team_size: string;
  geography: string;
  product_desc: string;
  target_market: string;
  challenge: string;
  modules: string[];
  feature_request_title: string;
  feature_request_desc: string;
};

const EMPTY: Form = {
  company_name: "", domain: "", industry: "", stage: "", team_size: "",
  geography: "", product_desc: "", target_market: "", challenge: "",
  modules: ["chat", "strategy", "production"],
  feature_request_title: "", feature_request_desc: "",
};

const STAGES = [
  { value: "pre-revenue", label: "Pre-revenue", desc: "Idea / validation stage" },
  { value: "early", label: "Early Stage", desc: "First customers" },
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

// ─── Component ────────────────────────────────────────────────────────────────

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<Form>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [submittingRequest, setSubmittingRequest] = useState(false);
  const [requestSubmitted, setRequestSubmitted] = useState(false);

  const selectedDomain = DOMAINS.find(d => d.key === form.domain);
  const domainFeatures = form.domain ? (FEATURE_CATALOG[form.domain] ?? []) : [];

  function set<K extends keyof Form>(k: K, v: Form[K]) {
    setForm(f => ({ ...f, [k]: v }));
  }

  function toggleModule(key: string) {
    setForm(f => ({
      ...f,
      modules: f.modules.includes(key) ? f.modules.filter(m => m !== key) : [...f.modules, key],
    }));
  }

  async function finish() {
    setSaving(true);
    try {
      const res = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company_name: form.company_name,
          industry: form.domain || form.industry,
          stage: form.stage,
          team_size: form.team_size,
          geography: form.geography,
          product_desc: form.product_desc,
          target_market: form.target_market,
          challenge: form.challenge,
          modules: form.modules,
        }),
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

    // Fire-and-forget strategy seeding
    if (form.modules.includes("strategy")) {
      fetch("/api/strategy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "competitor", title: `${form.company_name} — Competitive Analysis` }),
      }).catch(() => {});
    }

    // Navigate to domain hub if selected, else chat
    if (form.domain && form.domain !== "general") {
      const path = form.domain === "agency" ? "/agency" : `/domains/${form.domain}`;
      router.push(path);
    } else {
      router.push("/chat");
    }
  }

  async function submitFeatureRequest() {
    if (!form.feature_request_title.trim() || !form.feature_request_desc.trim()) return;
    setSubmittingRequest(true);
    try {
      const res = await fetch("/api/feature-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: form.feature_request_title,
          description: form.feature_request_desc,
          category: "feature",
          domain: form.domain || "general",
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data?.error ?? "Could not submit your request.");
        return;
      }
      setRequestSubmitted(true);
    } finally { setSubmittingRequest(false); }
  }

  const canNext = [
    form.domain, // Step 0: domain selected
    form.company_name.trim() && form.stage && form.team_size, // Step 1: profile
    form.product_desc.trim() && form.challenge, // Step 2: context
    form.modules.length > 0, // Step 3: modules
    true, // Step 4: feature request (optional)
  ][step];

  const STEP_LABELS = ["Choose Domain", "Your Profile", "Business Context", "Configure Features", "Any Requests?"];

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-2xl">

        {/* Brand */}
        <div className="flex items-center gap-2 mb-8 justify-center">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/15">
            <Sparkles className="h-5 w-5 text-primary" />
          </div>
          <span className="font-semibold tracking-tight text-lg">{KERNELHUB_NAME}</span>
        </div>

        {/* Progress */}
        <div className="flex items-center gap-1.5 mb-8 overflow-x-auto pb-1">
          {STEP_LABELS.map((s, i) => (
            <div key={s} className="flex items-center gap-1.5 flex-1 min-w-0">
              <div className={cn(
                "h-6 w-6 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 transition-colors",
                i < step ? "bg-primary text-primary-foreground"
                : i === step ? "bg-primary text-primary-foreground"
                : "bg-secondary text-muted-foreground"
              )}>
                {i < step ? <Check className="h-3 w-3" /> : i + 1}
              </div>
              <span className={cn("text-[10px] hidden sm:block truncate", i === step ? "text-foreground font-medium" : "text-muted-foreground")}>{s}</span>
              {i < STEP_LABELS.length - 1 && <div className={cn("flex-1 h-px min-w-[12px]", i < step ? "bg-primary" : "bg-border")} />}
            </div>
          ))}
        </div>

        {/* Card */}
        <div className="rounded-2xl border border-border bg-card p-7 shadow-sm">

          {/* ─ Step 0: Domain Selector ─ */}
          {step === 0 && (
            <div className="space-y-5">
              <div>
                <h1 className="text-xl font-semibold flex items-center gap-2">
                  <Briefcase className="h-5 w-5 text-primary" /> What best describes you?
                </h1>
                <p className="text-sm text-muted-foreground mt-1">
                  KernelHub will configure your workspace, AI tools, and features for your specific domain.
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {DOMAINS.map(domain => {
                  const Icon = domain.icon;
                  const selected = form.domain === domain.key;
                  return (
                    <button
                      key={domain.key}
                      onClick={() => set("domain", domain.key)}
                      className={cn(
                        "rounded-xl border p-4 text-left flex items-start gap-3 transition-all hover:scale-[1.01]",
                        selected ? `${domain.active} border-2 shadow-sm` : `border-border bg-background hover:border-primary/30`
                      )}
                    >
                      <div className={cn("h-8 w-8 rounded-lg flex items-center justify-center shrink-0", selected ? domain.bg : "bg-secondary")}>
                        <Icon className={cn("h-4 w-4", selected ? domain.color : "text-muted-foreground")} />
                      </div>
                      <div className="min-w-0">
                        <div className={cn("text-sm font-semibold", selected ? domain.color : "text-foreground")}>{domain.label}</div>
                        <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{domain.desc}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* ─ Step 1: Company Profile ─ */}
          {step === 1 && (
            <div className="space-y-5">
              <div>
                <h1 className="text-xl font-semibold flex items-center gap-2">
                  {selectedDomain && <selectedDomain.icon className={cn("h-5 w-5", selectedDomain.color)} />}
                  Tell us about your {selectedDomain?.label ?? "organization"}
                </h1>
                <p className="text-sm text-muted-foreground mt-1">
                  This shapes your entire workspace — strategies, templates, and AI context.
                </p>
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1.5">
                  {form.domain === "nonprofit" ? "Organization name *" : form.domain === "education" ? "School / Platform name *" : "Company name *"}
                </label>
                <input value={form.company_name} onChange={e => set("company_name", e.target.value)}
                  placeholder={form.domain === "nonprofit" ? "Hope Foundation" : form.domain === "healthcare" ? "Sunrise Health Clinic" : "Acme Corp"}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/30" />
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-2">Organization stage *</label>
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

          {/* ─ Step 2: Business Context ─ */}
          {step === 2 && (
            <div className="space-y-5">
              <div>
                <h1 className="text-xl font-semibold">What do you do?</h1>
                <p className="text-sm text-muted-foreground mt-1">
                  KernelHub uses this to generate deeply relevant AI outputs for your specific work.
                </p>
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1.5">
                  {form.domain === "healthcare" ? "What services do you provide? *"
                  : form.domain === "education" ? "What do you teach or build? *"
                  : form.domain === "nonprofit" ? "What is your mission? *"
                  : "What do you sell / what is your product? *"}
                </label>
                <textarea value={form.product_desc} onChange={e => set("product_desc", e.target.value)}
                  placeholder={
                    form.domain === "healthcare" ? "We provide primary care and telehealth services to adults..."
                    : form.domain === "education" ? "We teach Python programming to beginners via an online platform..."
                    : form.domain === "nonprofit" ? "We provide clean water access to rural communities in East Africa..."
                    : "e.g. We build B2B SaaS tools for project management..."
                  }
                  className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/30 min-h-[90px] resize-none" />
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1.5">
                  {form.domain === "nonprofit" ? "Who do you serve?" : "Who is your target customer?"}
                </label>
                <input value={form.target_market} onChange={e => set("target_market", e.target.value)}
                  placeholder={
                    form.domain === "healthcare" ? "Adults 30–65 with chronic conditions"
                    : form.domain === "nonprofit" ? "Rural communities in developing nations"
                    : "e.g. B2B mid-market, CTOs at 50–500 person companies"
                  }
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
            </div>
          )}

          {/* ─ Step 3: Feature Selection ─ */}
          {step === 3 && (
            <div className="space-y-5">
              <div>
                <h1 className="text-xl font-semibold">Configure your workspace</h1>
                <p className="text-sm text-muted-foreground mt-1">
                  Pre-selected features are recommended for <strong>{selectedDomain?.label ?? "your domain"}</strong>. Add or remove as needed.
                </p>
              </div>

              {domainFeatures.length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
                    {selectedDomain?.label} Features
                  </div>
                  <div className="space-y-2">
                    {domainFeatures.map(f => {
                      const on = form.modules.includes(f.key);
                      return (
                        <button key={f.key} onClick={() => toggleModule(f.key)}
                          className={cn("w-full rounded-xl border px-4 py-3 flex items-center gap-3 text-left transition-all",
                            on ? "border-primary bg-primary/8" : "border-border bg-background hover:border-primary/30"
                          )}>
                          <span className="text-lg shrink-0">{f.icon}</span>
                          <div className="flex-1 min-w-0">
                            <div className={cn("text-sm font-medium", on ? "text-primary" : "")}>{f.label}</div>
                            <div className="text-xs text-muted-foreground">{f.desc}</div>
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
                </div>
              )}

              <div>
                <div className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
                  Core Platform Tools
                </div>
                <div className="grid grid-cols-1 gap-2">
                  {CORE_MODULES.filter(m => !domainFeatures.some(f => f.key === m.key)).map(m => {
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
              </div>

              <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
                <p className="text-xs text-muted-foreground">
                  Based on your profile, KernelHub will pre-generate a{" "}
                  <strong className="text-foreground">{selectedDomain?.label ?? "custom"}-specific</strong> strategy framework
                  and configure your workspace with <strong className="text-foreground">{form.modules.length} tools</strong> active.
                </p>
              </div>
            </div>
          )}

          {/* ─ Step 4: Feature Request ─ */}
          {step === 4 && (
            <div className="space-y-5">
              <div>
                <h1 className="text-xl font-semibold flex items-center gap-2">
                  <Lightbulb className="h-5 w-5 text-amber-500" /> Missing something?
                </h1>
                <p className="text-sm text-muted-foreground mt-1">
                  Tell us about any features you&apos;d love to have. We read every request and build the most-voted ones.
                </p>
              </div>

              {requestSubmitted ? (
                <div className="rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/30 p-6 text-center space-y-2">
                  <div className="h-10 w-10 rounded-full bg-emerald-100 dark:bg-emerald-900 flex items-center justify-center mx-auto">
                    <Check className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <p className="font-semibold text-sm text-emerald-700 dark:text-emerald-400">Feature request submitted!</p>
                  <p className="text-xs text-muted-foreground">We&apos;ll review it and let you know when it&apos;s planned.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1.5">Feature title</label>
                    <input value={form.feature_request_title} onChange={e => set("feature_request_title", e.target.value)}
                      placeholder="e.g. Slack notifications for high-risk standups"
                      className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/30" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1.5">Description</label>
                    <textarea value={form.feature_request_desc} onChange={e => set("feature_request_desc", e.target.value)}
                      rows={4} placeholder="Describe what you need and why it would be valuable..."
                      className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/30 resize-none" />
                  </div>
                  {form.feature_request_title.trim() && form.feature_request_desc.trim() && (
                    <button onClick={submitFeatureRequest} disabled={submittingRequest}
                      className="flex items-center gap-2 text-sm text-primary hover:underline font-medium transition-colors">
                      {submittingRequest ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                      {submittingRequest ? "Submitting..." : "Submit request (optional — continue anytime)"}
                    </button>
                  )}
                </div>
              )}

              <div className="rounded-xl border border-border bg-secondary/30 p-4 space-y-1">
                <p className="text-xs font-semibold">You&apos;re all set! 🎉</p>
                <p className="text-xs text-muted-foreground">
                  Click <strong>Launch KernelHub</strong> to open your{" "}
                  <strong>{selectedDomain?.label ?? "personalized"}</strong> workspace with{" "}
                  {form.modules.length} features enabled.
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
            <button
              onClick={() => router.push("/chat")}
              className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
            >
              Skip for now
            </button>

            {step < 4 ? (
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
                disabled={saving}
                className="flex items-center gap-1.5 bg-primary text-primary-foreground rounded-lg px-5 py-2.5 text-sm font-semibold disabled:opacity-40 hover:bg-primary/90 transition-colors"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {saving ? "Setting up workspace..." : "Launch KernelHub"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
