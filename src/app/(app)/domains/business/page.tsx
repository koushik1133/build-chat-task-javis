"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Rocket, DollarSign, TrendingUp, Users, Zap, Target,
  Plus, Sparkles, RefreshCw, X, Loader2, ChevronRight, BarChart2
} from "lucide-react";
import { Button } from "@/components/ui/button";

type Investor = {
  id: string;
  investor_name: string;
  firm: string | null;
  email: string | null;
  check_size: string | null;
  focus_areas: string | null;
  stage: string;
  notes: string | null;
  created_at: string;
};

type Tab = "investors" | "pitch" | "gtm" | "burn";

const STAGE_COLORS: Record<string, string> = {
  identified: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  contacted: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-400",
  meeting: "bg-purple-50 text-purple-700 dark:bg-purple-950 dark:text-purple-400",
  term_sheet: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-400",
  closed: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
  passed: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-400",
};

const STAGES = ["identified", "contacted", "meeting", "term_sheet", "closed", "passed"];

export default function BusinessPage() {
  const [tab, setTab] = useState<Tab>("investors");
  const [investors, setInvestors] = useState<Investor[]>([]);
  const [loading, setLoading] = useState(true);

  // Investor form
  const [showAddInvestor, setShowAddInvestor] = useState(false);
  const [investorForm, setInvestorForm] = useState({
    investor_name: "", firm: "", email: "", check_size: "", focus_areas: "", stage: "identified", notes: ""
  });
  const [addingInvestor, setAddingInvestor] = useState(false);

  // Pitch deck
  const [pitchForm, setPitchForm] = useState({
    company_name: "", product_desc: "", target_market: "", traction: "", funding_ask: "", use_of_funds: ""
  });
  const [pitchResult, setPitchResult] = useState<string | null>(null);
  const [generatingPitch, setGeneratingPitch] = useState(false);

  // GTM Strategy
  const [gtmForm, setGtmForm] = useState({
    company_name: "", product_desc: "", target_market: "", budget_range: "$0-$5k/mo", timeframe: "90 days"
  });
  const [gtmResult, setGtmResult] = useState<string | null>(null);
  const [generatingGtm, setGeneratingGtm] = useState(false);

  // Burn Rate
  const [burnForm, setBurnForm] = useState({
    monthly_burn: 20000, cash_on_hand: 500000, monthly_revenue: 5000, growth_rate: 15
  });
  const [burnResult, setBurnResult] = useState<{ metrics: Record<string, unknown>; analysis: string } | null>(null);
  const [calculatingBurn, setCalculatingBurn] = useState(false);

  const fetchInvestors = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/domains/business?action=investors");
      const data = await res.json().catch(() => ({}));
      setInvestors(data.investors ?? []);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchInvestors(); }, [fetchInvestors]);

  async function handleAddInvestor() {
    if (!investorForm.investor_name) return;
    setAddingInvestor(true);
    try {
      const res = await fetch("/api/domains/business", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add_investor", ...investorForm }),
      });
      const data = await res.json();
      if (data.investor) {
        setInvestors(inv => [data.investor, ...inv]);
        setShowAddInvestor(false);
        setInvestorForm({ investor_name: "", firm: "", email: "", check_size: "", focus_areas: "", stage: "identified", notes: "" });
      }
    } finally { setAddingInvestor(false); }
  }

  async function handleUpdateStage(id: string, stage: string) {
    const res = await fetch("/api/domains/business", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update_stage", id, stage }),
    });
    const data = await res.json();
    if (data.investor) {
      setInvestors(inv => inv.map(i => i.id === id ? data.investor : i));
    }
  }

  async function handleGeneratePitch() {
    if (!pitchForm.company_name) return;
    setGeneratingPitch(true); setPitchResult(null);
    try {
      const res = await fetch("/api/domains/business", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generate_pitch", ...pitchForm }),
      });
      const data = await res.json();
      setPitchResult(data.pitch_outline ?? "Failed to generate pitch.");
    } finally { setGeneratingPitch(false); }
  }

  async function handleGenerateGtm() {
    if (!gtmForm.company_name) return;
    setGeneratingGtm(true); setGtmResult(null);
    try {
      const res = await fetch("/api/domains/business", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "gtm_strategy", ...gtmForm }),
      });
      const data = await res.json();
      setGtmResult(data.gtm_strategy ?? "Failed to generate GTM strategy.");
    } finally { setGeneratingGtm(false); }
  }

  async function handleBurnAnalysis() {
    setCalculatingBurn(true); setBurnResult(null);
    try {
      const res = await fetch("/api/domains/business", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "burn_analysis", ...burnForm }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && !data?.error) {
        setBurnResult(data);
      } else {
        setBurnResult(null);
        alert(data?.error ?? "Burn analysis failed");
      }
    } finally { setCalculatingBurn(false); }
  }

  const closedDeals = investors.filter(i => i.stage === "closed");
  const inPipeline = investors.filter(i => !["closed", "passed"].includes(i.stage));

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "investors", label: "Investor CRM", icon: <Users className="h-3.5 w-3.5" /> },
    { id: "pitch", label: "Pitch Deck AI", icon: <Rocket className="h-3.5 w-3.5" /> },
    { id: "gtm", label: "GTM Strategy", icon: <Target className="h-3.5 w-3.5" /> },
    { id: "burn", label: "Burn Rate Analyzer", icon: <BarChart2 className="h-3.5 w-3.5" /> },
  ];

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden px-4 py-5 sm:px-6 sm:py-7 lg:px-8 lg:py-8">
      <div className="mx-auto w-full max-w-7xl space-y-6">

        {/* ── Header ── */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl flex items-center gap-2">
              <Rocket className="h-6 w-6 text-violet-500" />
              Business / Startup Hub
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Investor CRM, AI pitch deck generator, GTM planner, and burn rate analysis for founders.
            </p>
          </div>
          <Button onClick={() => setShowAddInvestor(true)} className="shrink-0">
            <Plus className="h-3.5 w-3.5 mr-1" /> Add Investor
          </Button>
        </div>

        {/* ── Stats ── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between text-muted-foreground mb-2">
              <span className="text-xs">Investors Tracked</span>
              <Users className="h-4 w-4 text-violet-500" />
            </div>
            <div className="text-2xl font-bold">{investors.length}</div>
            <div className="text-[11px] text-muted-foreground mt-1">In your pipeline</div>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between text-muted-foreground mb-2">
              <span className="text-xs">Active Pipeline</span>
              <TrendingUp className="h-4 w-4 text-blue-500" />
            </div>
            <div className="text-2xl font-bold">{inPipeline.length}</div>
            <div className="text-[11px] text-muted-foreground mt-1">Warm conversations</div>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between text-muted-foreground mb-2">
              <span className="text-xs">Closed Deals</span>
              <DollarSign className="h-4 w-4 text-emerald-500" />
            </div>
            <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{closedDeals.length}</div>
            <div className="text-[11px] text-muted-foreground mt-1">Committed investors</div>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between text-muted-foreground mb-2">
              <span className="text-xs">In Meeting Stage</span>
              <Zap className="h-4 w-4 text-amber-500" />
            </div>
            <div className="text-2xl font-bold text-amber-600 dark:text-amber-400">
              {investors.filter(i => i.stage === "meeting").length}
            </div>
            <div className="text-[11px] text-muted-foreground mt-1">Active discussions</div>
          </div>
        </div>

        {/* ── Tabs ── */}
        <div className="flex gap-1 overflow-x-auto border-b border-border pb-0 -mb-6">
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-medium whitespace-nowrap border-b-2 transition-colors ${
                tab === t.id
                  ? "border-violet-500 text-violet-600 dark:text-violet-400"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
              }`}>
              {t.icon}{t.label}
            </button>
          ))}
        </div>

        <div className="pt-2">
          {loading && (
            <div className="text-xs text-muted-foreground flex items-center gap-1.5 py-1 mb-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-500" /> Loading data...
            </div>
          )}

          {/* ════ INVESTOR CRM TAB */}
          {tab === "investors" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{investors.length} Investors</span>
                <Button size="sm" onClick={() => setShowAddInvestor(true)}>
                  <Plus className="h-3.5 w-3.5 mr-1" /> Add Investor
                </Button>
              </div>

              {investors.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border p-12 text-center">
                  <Users className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
                  <p className="text-sm font-medium mb-1">No investors tracked yet</p>
                  <p className="text-xs text-muted-foreground mb-4">
                    Track your investor conversations from first contact to term sheet.
                  </p>
                  <Button size="sm" onClick={() => setShowAddInvestor(true)}>
                    <Plus className="h-3.5 w-3.5 mr-1" /> Add First Investor
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  {investors.map(inv => (
                    <div key={inv.id} className="rounded-xl border border-border bg-card p-4 flex flex-col sm:flex-row sm:items-center gap-3 hover:border-violet-500/30 transition-colors">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <h3 className="font-semibold text-sm">{inv.investor_name}</h3>
                          {inv.firm && <span className="text-xs text-muted-foreground">@ {inv.firm}</span>}
                        </div>
                        {inv.check_size && (
                          <p className="text-xs text-muted-foreground mt-0.5">
                            Check: <strong className="text-foreground">{inv.check_size}</strong>
                            {inv.focus_areas && ` · Focus: ${inv.focus_areas}`}
                          </p>
                        )}
                        {inv.notes && <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{inv.notes}</p>}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <select
                          value={inv.stage}
                          onChange={e => handleUpdateStage(inv.id, e.target.value)}
                          className={`text-xs font-medium px-2.5 py-1.5 rounded-lg border-0 outline-none cursor-pointer ${STAGE_COLORS[inv.stage] ?? ""}`}
                        >
                          {STAGES.map(s => (
                            <option key={s} value={s} className="bg-background text-foreground">
                              {s.replace("_", " ").toUpperCase()}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ════ PITCH DECK AI TAB */}
          {tab === "pitch" && (
            <div className="space-y-6 max-w-3xl">
              <div className="rounded-xl border border-border bg-card p-5 space-y-4">
                <div className="flex items-center gap-2">
                  <Rocket className="h-5 w-5 text-violet-500" />
                  <div>
                    <h2 className="text-base font-semibold">AI Pitch Deck Architect</h2>
                    <p className="text-xs text-muted-foreground">
                      Generate a 12-slide investor-ready pitch deck outline with specific content guidance.
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">Company Name *</label>
                    <input value={pitchForm.company_name} onChange={e => setPitchForm(f => ({ ...f, company_name: e.target.value }))}
                      placeholder="Acme AI" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-violet-500/30" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">Funding Ask</label>
                    <input value={pitchForm.funding_ask} onChange={e => setPitchForm(f => ({ ...f, funding_ask: e.target.value }))}
                      placeholder="$500k SAFE" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none" />
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">What do you build? *</label>
                  <textarea value={pitchForm.product_desc} onChange={e => setPitchForm(f => ({ ...f, product_desc: e.target.value }))}
                    rows={3} placeholder="We build AI-powered X for Y target market..."
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-violet-500/30 resize-none" />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">Target Market</label>
                    <input value={pitchForm.target_market} onChange={e => setPitchForm(f => ({ ...f, target_market: e.target.value }))}
                      placeholder="B2B SaaS, mid-market" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">Traction</label>
                    <input value={pitchForm.traction} onChange={e => setPitchForm(f => ({ ...f, traction: e.target.value }))}
                      placeholder="10 paying customers, $5k MRR" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none" />
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Use of Funds</label>
                  <input value={pitchForm.use_of_funds} onChange={e => setPitchForm(f => ({ ...f, use_of_funds: e.target.value }))}
                    placeholder="50% eng, 30% sales, 20% ops" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none" />
                </div>

                <Button onClick={handleGeneratePitch} disabled={generatingPitch || !pitchForm.company_name || !pitchForm.product_desc}>
                  {generatingPitch ? <RefreshCw className="h-4 w-4 animate-spin mr-2" /> : <Sparkles className="h-4 w-4 mr-2" />}
                  {generatingPitch ? "Building Pitch Architecture..." : "Generate AI Pitch Deck Outline"}
                </Button>
              </div>

              {pitchResult && (
                <div className="rounded-xl border border-border bg-card p-5">
                  <div className="flex items-center gap-2 mb-3 pb-3 border-b border-border/40">
                    <Rocket className="h-4 w-4 text-violet-500" />
                    <h3 className="font-semibold text-sm">12-Slide Pitch Deck Outline</h3>
                  </div>
                  <pre className="text-sm text-foreground font-sans whitespace-pre-wrap leading-relaxed">{pitchResult}</pre>
                </div>
              )}
            </div>
          )}

          {/* ════ GTM STRATEGY TAB */}
          {tab === "gtm" && (
            <div className="space-y-6 max-w-3xl">
              <div className="rounded-xl border border-border bg-card p-5 space-y-4">
                <div className="flex items-center gap-2">
                  <Target className="h-5 w-5 text-amber-500" />
                  <div>
                    <h2 className="text-base font-semibold">Go-To-Market Strategy Generator</h2>
                    <p className="text-xs text-muted-foreground">
                      AI-generated GTM strategy with channel ranking, 30/60/90 day plan, and KPI framework.
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">Company Name *</label>
                    <input value={gtmForm.company_name} onChange={e => setGtmForm(f => ({ ...f, company_name: e.target.value }))}
                      placeholder="Acme AI" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-500/30" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">Marketing Budget</label>
                    <select value={gtmForm.budget_range} onChange={e => setGtmForm(f => ({ ...f, budget_range: e.target.value }))}
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none">
                      <option>$0-$5k/mo</option>
                      <option>$5k-$20k/mo</option>
                      <option>$20k-$100k/mo</option>
                      <option>$100k+/mo</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Product Description *</label>
                  <textarea value={gtmForm.product_desc} onChange={e => setGtmForm(f => ({ ...f, product_desc: e.target.value }))}
                    rows={3} placeholder="Describe your product and core value prop..."
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none resize-none" />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">Target Market</label>
                    <input value={gtmForm.target_market} onChange={e => setGtmForm(f => ({ ...f, target_market: e.target.value }))}
                      placeholder="SMBs, HR teams" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">Launch Timeframe</label>
                    <select value={gtmForm.timeframe} onChange={e => setGtmForm(f => ({ ...f, timeframe: e.target.value }))}
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none">
                      <option>30 days</option>
                      <option>60 days</option>
                      <option>90 days</option>
                      <option>6 months</option>
                    </select>
                  </div>
                </div>

                <Button onClick={handleGenerateGtm} disabled={generatingGtm || !gtmForm.company_name} variant="outline" className="border-amber-500 text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-950/20">
                  {generatingGtm ? <RefreshCw className="h-4 w-4 animate-spin mr-2" /> : <Target className="h-4 w-4 mr-2" />}
                  {generatingGtm ? "Building GTM Strategy..." : "Generate GTM Strategy"}
                </Button>
              </div>

              {gtmResult && (
                <div className="rounded-xl border border-border bg-card p-5">
                  <div className="flex items-center gap-2 mb-3 pb-3 border-b border-border/40">
                    <Target className="h-4 w-4 text-amber-500" />
                    <h3 className="font-semibold text-sm">Go-To-Market Strategy</h3>
                  </div>
                  <pre className="text-sm text-foreground font-sans whitespace-pre-wrap leading-relaxed">{gtmResult}</pre>
                </div>
              )}
            </div>
          )}

          {/* ════ BURN RATE ANALYZER TAB */}
          {tab === "burn" && (
            <div className="space-y-6 max-w-3xl">
              <div className="rounded-xl border border-border bg-card p-5 space-y-4">
                <div className="flex items-center gap-2">
                  <BarChart2 className="h-5 w-5 text-primary" />
                  <div>
                    <h2 className="text-base font-semibold">Burn Rate & Runway Analyzer</h2>
                    <p className="text-xs text-muted-foreground">
                      Calculate your runway, net burn, and get AI-powered financial optimization recommendations.
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  {[
                    { label: "Monthly Burn ($)", key: "monthly_burn" as const },
                    { label: "Cash on Hand ($)", key: "cash_on_hand" as const },
                    { label: "Monthly Revenue ($)", key: "monthly_revenue" as const },
                    { label: "MoM Growth Rate (%)", key: "growth_rate" as const },
                  ].map(field => (
                    <div key={field.key}>
                      <label className="text-xs font-medium text-muted-foreground mb-1 block">{field.label}</label>
                      <input
                        type="number"
                        value={burnForm[field.key]}
                        onChange={e => setBurnForm(f => ({ ...f, [field.key]: Number(e.target.value) }))}
                        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                      />
                    </div>
                  ))}
                </div>

                <Button onClick={handleBurnAnalysis} disabled={calculatingBurn}>
                  {calculatingBurn ? <RefreshCw className="h-4 w-4 animate-spin mr-2" /> : <BarChart2 className="h-4 w-4 mr-2" />}
                  {calculatingBurn ? "Analyzing Financial Position..." : "Analyze Burn Rate + Runway"}
                </Button>
              </div>

              {burnResult && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {[
                      { label: "Monthly Burn", value: `$${Number(burnResult.metrics.monthly_burn).toLocaleString()}`, color: "text-red-600 dark:text-red-400" },
                      { label: "Net Burn", value: `$${Number(burnResult.metrics.net_burn).toLocaleString()}`, color: "text-amber-600 dark:text-amber-400" },
                      { label: "Runway", value: `${burnResult.metrics.runway_months} mo`, color: "text-primary" },
                      { label: "Revenue", value: `$${Number(burnResult.metrics.monthly_revenue).toLocaleString()}/mo`, color: "text-emerald-600 dark:text-emerald-400" },
                    ].map(metric => (
                      <div key={metric.label} className="rounded-xl border border-border bg-card p-4 text-center">
                        <div className={`text-xl font-bold ${metric.color}`}>{metric.value}</div>
                        <div className="text-[11px] text-muted-foreground mt-1">{metric.label}</div>
                      </div>
                    ))}
                  </div>

                  <div className="rounded-xl border border-border bg-card p-5">
                    <div className="flex items-center gap-2 mb-3 pb-3 border-b border-border/40">
                      <ChevronRight className="h-4 w-4 text-primary" />
                      <h3 className="font-semibold text-sm">AI Financial Analysis</h3>
                    </div>
                    <pre className="text-sm text-foreground font-sans whitespace-pre-wrap leading-relaxed">
                      {burnResult.analysis}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Add Investor Modal ── */}
      {showAddInvestor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={() => setShowAddInvestor(false)}>
          <div className="bg-card border border-border rounded-xl p-6 w-full max-w-lg shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-border/40 pb-3">
              <h2 className="font-semibold text-base flex items-center gap-2">
                <Users className="h-4 w-4 text-violet-500" /> Add Investor
              </h2>
              <button onClick={() => setShowAddInvestor(false)}><X className="h-4 w-4 text-muted-foreground" /></button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Investor Name *</label>
                <input value={investorForm.investor_name} onChange={e => setInvestorForm(f => ({ ...f, investor_name: e.target.value }))}
                  placeholder="John Smith" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Firm / Fund</label>
                <input value={investorForm.firm} onChange={e => setInvestorForm(f => ({ ...f, firm: e.target.value }))}
                  placeholder="Sequoia Capital" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none" />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Email</label>
                <input value={investorForm.email} onChange={e => setInvestorForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="investor@vc.com" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Check Size</label>
                <input value={investorForm.check_size} onChange={e => setInvestorForm(f => ({ ...f, check_size: e.target.value }))}
                  placeholder="$25k-$250k" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none" />
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Focus Areas</label>
              <input value={investorForm.focus_areas} onChange={e => setInvestorForm(f => ({ ...f, focus_areas: e.target.value }))}
                placeholder="B2B SaaS, AI, FinTech" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none" />
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Stage</label>
              <select value={investorForm.stage} onChange={e => setInvestorForm(f => ({ ...f, stage: e.target.value }))}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none">
                {STAGES.map(s => <option key={s} value={s}>{s.replace("_", " ").toUpperCase()}</option>)}
              </select>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Notes</label>
              <textarea value={investorForm.notes} onChange={e => setInvestorForm(f => ({ ...f, notes: e.target.value }))}
                rows={2} placeholder="Key discussion points, warm intro via..."
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none resize-none" />
            </div>

            <div className="flex gap-3 pt-2">
              <Button variant="outline" onClick={() => setShowAddInvestor(false)} className="flex-1">Cancel</Button>
              <Button onClick={handleAddInvestor} disabled={addingInvestor || !investorForm.investor_name} className="flex-1">
                {addingInvestor ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Plus className="h-4 w-4 mr-2" />}
                Add to Pipeline
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
