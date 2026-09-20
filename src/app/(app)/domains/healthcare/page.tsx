"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Heart, Stethoscope, ShieldCheck, BarChart2, Plus,
  Sparkles, RefreshCw, Users, AlertTriangle, CheckCircle, X, Loader2
} from "lucide-react";
import { Button } from "@/components/ui/button";

type Patient = {
  id: string;
  full_name: string;
  dob: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  chief_complaint: string;
  medical_history: string | null;
  medications: string | null;
  allergies: string | null;
  hipaa_consent: boolean;
  ai_summary: string | null;
  created_at: string;
};

type Tab = "patients" | "note_summarizer" | "hipaa" | "analytics";

export default function HealthcarePage() {
  const [tab, setTab] = useState<Tab>("patients");
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(true);

  // Patient intake form
  const [showIntakeForm, setShowIntakeForm] = useState(false);
  const [intakeForm, setIntakeForm] = useState({
    full_name: "", dob: "", contact_email: "", contact_phone: "",
    chief_complaint: "", medical_history: "", medications: "", allergies: "", hipaa_consent: false
  });
  const [submittingIntake, setSubmittingIntake] = useState(false);

  // Note summarizer
  const [noteText, setNoteText] = useState("");
  const [noteSummary, setNoteSummary] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);

  // HIPAA checker
  const [hipaaText, setHipaaText] = useState("");
  const [hipaaResult, setHipaaResult] = useState<{
    violations: string[]; phi_found: string[]; recommendations: string[]; risk_level: string;
  } | null>(null);
  const [checkingHipaa, setCheckingHipaa] = useState(false);

  // Analytics
  const [insights, setInsights] = useState<string | null>(null);
  const [loadingInsights, setLoadingInsights] = useState(false);

  const fetchPatients = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/domains/healthcare?action=patients");
      const data = await res.json().catch(() => ({}));
      setPatients(data.patients ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchPatients(); }, [fetchPatients]);

  async function handlePatientIntake() {
    if (!intakeForm.full_name || !intakeForm.chief_complaint) return;
    setSubmittingIntake(true);
    try {
      const res = await fetch("/api/domains/healthcare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "patient_intake", ...intakeForm }),
      });
      const data = await res.json();
      if (data.patient) {
        setPatients(p => [data.patient, ...p]);
        setShowIntakeForm(false);
        setIntakeForm({ full_name: "", dob: "", contact_email: "", contact_phone: "", chief_complaint: "", medical_history: "", medications: "", allergies: "", hipaa_consent: false });
      }
    } finally { setSubmittingIntake(false); }
  }

  async function handleSummarizeNote() {
    if (!noteText.trim()) return;
    setSummarizing(true);
    setNoteSummary(null);
    try {
      const res = await fetch("/api/domains/healthcare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "summarize_note", note_text: noteText }),
      });
      const data = await res.json();
      setNoteSummary(data.summary ?? "No summary generated.");
    } finally { setSummarizing(false); }
  }

  async function handleHipaaCheck() {
    if (!hipaaText.trim()) return;
    setCheckingHipaa(true);
    setHipaaResult(null);
    try {
      const res = await fetch("/api/domains/healthcare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "hipaa_check", text_to_check: hipaaText }),
      });
      const data = await res.json();
      setHipaaResult(data.hipaa_check);
    } finally { setCheckingHipaa(false); }
  }

  async function handleLoadInsights() {
    setLoadingInsights(true);
    setInsights(null);
    try {
      const res = await fetch("/api/domains/healthcare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "health_insights" }),
      });
      const data = await res.json();
      setInsights(data.insights ?? "No insights available.");
    } finally { setLoadingInsights(false); }
  }

  const RISK_COLORS = {
    low: "bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
    medium: "bg-amber-50 border-amber-200 text-amber-700 dark:bg-amber-950 dark:text-amber-400",
    high: "bg-red-50 border-red-200 text-red-700 dark:bg-red-950 dark:text-red-400",
  };

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "patients", label: "Patient Intake", icon: <Users className="h-3.5 w-3.5" /> },
    { id: "note_summarizer", label: "SOAP Note Summarizer", icon: <Stethoscope className="h-3.5 w-3.5" /> },
    { id: "hipaa", label: "HIPAA Compliance", icon: <ShieldCheck className="h-3.5 w-3.5" /> },
    { id: "analytics", label: "Health Analytics", icon: <BarChart2 className="h-3.5 w-3.5" /> },
  ];

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden px-4 py-5 sm:px-6 sm:py-7 lg:px-8 lg:py-8">
      <div className="mx-auto w-full max-w-7xl space-y-6">

        {/* ── Header ── */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl flex items-center gap-2">
              <Heart className="h-6 w-6 text-rose-500" />
              Healthcare Hub
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              AI-powered patient intake, SOAP note summarization, HIPAA compliance checking, and health analytics.
            </p>
          </div>
          <Button onClick={() => setShowIntakeForm(true)} className="shrink-0">
            <Plus className="h-3.5 w-3.5 mr-1" /> New Patient Intake
          </Button>
        </div>

        {/* ── Stats Cards ── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between text-muted-foreground mb-2">
              <span className="text-xs">Total Patients</span>
              <Users className="h-4 w-4 text-rose-500" />
            </div>
            <div className="text-2xl font-bold">{patients.length}</div>
            <div className="text-[11px] text-muted-foreground mt-1">Patient records</div>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between text-muted-foreground mb-2">
              <span className="text-xs">HIPAA Consented</span>
              <ShieldCheck className="h-4 w-4 text-emerald-500" />
            </div>
            <div className="text-2xl font-bold">{patients.filter(p => p.hipaa_consent).length}</div>
            <div className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-1">Compliant records</div>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between text-muted-foreground mb-2">
              <span className="text-xs">AI Summaries</span>
              <Sparkles className="h-4 w-4 text-primary" />
            </div>
            <div className="text-2xl font-bold">{patients.filter(p => p.ai_summary).length}</div>
            <div className="text-[11px] text-muted-foreground mt-1">Auto-generated</div>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between text-muted-foreground mb-2">
              <span className="text-xs">Pending Consent</span>
              <AlertTriangle className="h-4 w-4 text-amber-500" />
            </div>
            <div className="text-2xl font-bold text-amber-600 dark:text-amber-400">
              {patients.filter(p => !p.hipaa_consent).length}
            </div>
            <div className="text-[11px] text-muted-foreground mt-1">Need HIPAA sign-off</div>
          </div>
        </div>

        {/* ── Tabs ── */}
        <div className="flex gap-1 overflow-x-auto border-b border-border pb-0 -mb-6">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-medium whitespace-nowrap border-b-2 transition-colors ${
                tab === t.id
                  ? "border-rose-500 text-rose-600 dark:text-rose-400"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
              }`}
            >
              {t.icon}{t.label}
            </button>
          ))}
        </div>

        <div className="pt-2">
          {loading && (
            <div className="text-xs text-muted-foreground flex items-center gap-1.5 py-1 mb-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-rose-500" /> Loading patient data...
            </div>
          )}

          {/* ════ PATIENTS TAB */}
          {tab === "patients" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{patients.length} Patient Records</span>
                <Button size="sm" onClick={() => setShowIntakeForm(true)}>
                  <Plus className="h-3.5 w-3.5 mr-1" /> New Intake
                </Button>
              </div>

              {patients.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border p-12 text-center">
                  <Heart className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
                  <p className="text-sm font-medium mb-1">No patient records yet</p>
                  <p className="text-xs text-muted-foreground mb-4">
                    Start by adding a patient intake record. AI will auto-generate a clinical summary.
                  </p>
                  <Button size="sm" onClick={() => setShowIntakeForm(true)}>
                    <Plus className="h-3.5 w-3.5 mr-1" /> Add First Patient
                  </Button>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {patients.map(p => (
                    <div key={p.id} className="rounded-xl border border-border bg-card p-5 space-y-3 hover:border-rose-500/30 transition-colors">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <h3 className="font-semibold text-base">{p.full_name}</h3>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {p.contact_email ?? p.contact_phone ?? "No contact info"}
                            {p.dob && ` · DOB: ${p.dob}`}
                          </p>
                        </div>
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                          p.hipaa_consent
                            ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
                            : "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-400"
                        }`}>
                          {p.hipaa_consent ? "✓ HIPAA" : "⚠ No Consent"}
                        </span>
                      </div>

                      <div className="rounded-lg bg-rose-50 dark:bg-rose-950/20 border border-rose-200/60 dark:border-rose-900/40 p-3">
                        <div className="text-[10px] font-semibold text-rose-600 dark:text-rose-400 mb-1">Chief Complaint</div>
                        <p className="text-xs text-foreground">{p.chief_complaint}</p>
                      </div>

                      {p.ai_summary && (
                        <div className="text-[11px] text-muted-foreground flex items-start gap-1.5 italic border-t border-border/40 pt-2">
                          <Sparkles className="h-3 w-3 text-primary shrink-0 mt-0.5" />
                          <span>AI Summary: {p.ai_summary}</span>
                        </div>
                      )}

                      {(p.medications || p.allergies) && (
                        <div className="grid grid-cols-2 gap-2 text-[11px]">
                          {p.medications && (
                            <div>
                              <span className="text-muted-foreground block font-medium">Medications</span>
                              <span>{p.medications}</span>
                            </div>
                          )}
                          {p.allergies && (
                            <div>
                              <span className="text-muted-foreground block font-medium">Allergies</span>
                              <span className="text-red-600 dark:text-red-400">{p.allergies}</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ════ SOAP NOTE SUMMARIZER TAB */}
          {tab === "note_summarizer" && (
            <div className="space-y-6 max-w-3xl">
              <div className="rounded-xl border border-border bg-card p-5 space-y-4">
                <div className="flex items-center gap-2">
                  <Stethoscope className="h-5 w-5 text-rose-500" />
                  <div>
                    <h2 className="text-base font-semibold">AI Clinical Note → SOAP Converter</h2>
                    <p className="text-xs text-muted-foreground">
                      Paste any clinical note and AI will structure it into Subjective, Objective, Assessment, and Plan format.
                    </p>
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Clinical Note Text *</label>
                  <textarea
                    value={noteText}
                    onChange={e => setNoteText(e.target.value)}
                    rows={8}
                    placeholder="Paste your clinical note here... (e.g., 'Patient is a 45yo male presenting with chest pain for 2 days. Reports pain is 7/10, radiating to left arm...')"
                    className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-rose-500/30 resize-y"
                  />
                </div>
                <Button onClick={handleSummarizeNote} disabled={summarizing || !noteText.trim()} className="bg-rose-600 hover:bg-rose-700 text-white">
                  {summarizing ? <RefreshCw className="h-4 w-4 animate-spin mr-2" /> : <Stethoscope className="h-4 w-4 mr-2" />}
                  {summarizing ? "Generating SOAP Summary..." : "Convert to SOAP Format"}
                </Button>
              </div>

              {noteSummary && (
                <div className="rounded-xl border border-border bg-card p-5">
                  <div className="flex items-center gap-2 mb-3 pb-3 border-b border-border/40">
                    <CheckCircle className="h-4 w-4 text-emerald-500" />
                    <h3 className="font-semibold text-sm">SOAP Summary</h3>
                  </div>
                  <pre className="text-sm text-foreground font-sans whitespace-pre-wrap leading-relaxed">
                    {noteSummary}
                  </pre>
                </div>
              )}
            </div>
          )}

          {/* ════ HIPAA CHECKER TAB */}
          {tab === "hipaa" && (
            <div className="space-y-6 max-w-3xl">
              <div className="rounded-xl border border-border bg-card p-5 space-y-4">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-5 w-5 text-emerald-500" />
                  <div>
                    <h2 className="text-base font-semibold">HIPAA PHI Detection & Compliance Checker</h2>
                    <p className="text-xs text-muted-foreground">
                      Paste any text to identify Protected Health Information (PHI) and HIPAA compliance risks.
                    </p>
                  </div>
                </div>
                <div className="rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/40 p-3 text-xs text-amber-700 dark:text-amber-400">
                  ⚠️ <strong>Disclaimer:</strong> This tool provides AI-assisted guidance only and does not constitute legal advice. Always consult a HIPAA compliance officer for binding decisions.
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Text to Analyze *</label>
                  <textarea
                    value={hipaaText}
                    onChange={e => setHipaaText(e.target.value)}
                    rows={6}
                    placeholder="Paste the text you want to check for HIPAA compliance..."
                    className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-emerald-500/30 resize-y"
                  />
                </div>
                <Button onClick={handleHipaaCheck} disabled={checkingHipaa || !hipaaText.trim()} variant="outline" className="border-emerald-500 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/20">
                  {checkingHipaa ? <RefreshCw className="h-4 w-4 animate-spin mr-2" /> : <ShieldCheck className="h-4 w-4 mr-2" />}
                  {checkingHipaa ? "Analyzing for PHI..." : "Run HIPAA Compliance Check"}
                </Button>
              </div>

              {hipaaResult && (
                <div className="space-y-4">
                  <div className={`rounded-xl border p-5 ${RISK_COLORS[hipaaResult.risk_level as keyof typeof RISK_COLORS] ?? RISK_COLORS.low}`}>
                    <div className="flex items-center gap-2 mb-1">
                      <AlertTriangle className="h-4 w-4" />
                      <span className="font-bold text-sm">Risk Level: {hipaaResult.risk_level?.toUpperCase()}</span>
                    </div>
                  </div>

                  {hipaaResult.phi_found?.length > 0 && (
                    <div className="rounded-xl border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20 p-5">
                      <h4 className="font-semibold text-sm text-red-700 dark:text-red-400 mb-2">PHI Detected</h4>
                      <ul className="space-y-1">
                        {hipaaResult.phi_found.map((item, i) => (
                          <li key={i} className="text-xs text-red-600 dark:text-red-400 flex items-start gap-2">
                            <span className="shrink-0">•</span><span>{item}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {hipaaResult.recommendations?.length > 0 && (
                    <div className="rounded-xl border border-border bg-card p-5">
                      <h4 className="font-semibold text-sm mb-2">Recommendations</h4>
                      <ul className="space-y-1.5">
                        {hipaaResult.recommendations.map((rec, i) => (
                          <li key={i} className="text-xs flex items-start gap-2">
                            <CheckCircle className="h-3.5 w-3.5 text-emerald-500 shrink-0 mt-0.5" />
                            <span>{rec}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ════ HEALTH ANALYTICS TAB */}
          {tab === "analytics" && (
            <div className="space-y-6 max-w-3xl">
              <div className="rounded-xl border border-border bg-card p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <BarChart2 className="h-5 w-5 text-primary" />
                    <div>
                      <h2 className="text-base font-semibold">AI Practice Analytics</h2>
                      <p className="text-xs text-muted-foreground">
                        AI analyzes your patient data to surface trends and practice optimization insights.
                      </p>
                    </div>
                  </div>
                  <Button size="sm" onClick={handleLoadInsights} disabled={loadingInsights}>
                    {loadingInsights ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                    {loadingInsights ? " Analyzing..." : " Generate Insights"}
                  </Button>
                </div>

                <div className="grid grid-cols-3 gap-3 pt-2">
                  <div className="rounded-lg bg-secondary/40 p-3 text-center">
                    <div className="text-xl font-bold">{patients.length}</div>
                    <div className="text-[11px] text-muted-foreground">Total Patients</div>
                  </div>
                  <div className="rounded-lg bg-secondary/40 p-3 text-center">
                    <div className="text-xl font-bold">
                      {patients.length > 0 ? Math.round((patients.filter(p => p.hipaa_consent).length / patients.length) * 100) : 0}%
                    </div>
                    <div className="text-[11px] text-muted-foreground">HIPAA Compliance Rate</div>
                  </div>
                  <div className="rounded-lg bg-secondary/40 p-3 text-center">
                    <div className="text-xl font-bold">{patients.filter(p => p.ai_summary).length}</div>
                    <div className="text-[11px] text-muted-foreground">AI Summaries Generated</div>
                  </div>
                </div>
              </div>

              {insights && (
                <div className="rounded-xl border border-border bg-card p-5">
                  <div className="flex items-center gap-2 mb-3 pb-3 border-b border-border/40">
                    <Sparkles className="h-4 w-4 text-primary" />
                    <h3 className="font-semibold text-sm">AI Practice Insights</h3>
                  </div>
                  <pre className="text-sm text-foreground font-sans whitespace-pre-wrap leading-relaxed">
                    {insights}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Patient Intake Modal ── */}
      {showIntakeForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={() => setShowIntakeForm(false)}>
          <div className="bg-card border border-border rounded-xl p-6 w-full max-w-2xl shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-border/40 pb-3">
              <div>
                <h2 className="font-semibold text-base flex items-center gap-2">
                  <Heart className="h-4 w-4 text-rose-500" /> New Patient Intake
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">AI will generate a clinical summary automatically.</p>
              </div>
              <button onClick={() => setShowIntakeForm(false)}><X className="h-4 w-4 text-muted-foreground" /></button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Full Name *</label>
                <input value={intakeForm.full_name} onChange={e => setIntakeForm(f => ({ ...f, full_name: e.target.value }))}
                  placeholder="Jane Doe" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-500/30" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Date of Birth</label>
                <input type="date" value={intakeForm.dob} onChange={e => setIntakeForm(f => ({ ...f, dob: e.target.value }))}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none" />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Email</label>
                <input value={intakeForm.contact_email} onChange={e => setIntakeForm(f => ({ ...f, contact_email: e.target.value }))}
                  placeholder="patient@email.com" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Phone</label>
                <input value={intakeForm.contact_phone} onChange={e => setIntakeForm(f => ({ ...f, contact_phone: e.target.value }))}
                  placeholder="(555) 123-4567" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none" />
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Chief Complaint *</label>
              <textarea value={intakeForm.chief_complaint} onChange={e => setIntakeForm(f => ({ ...f, chief_complaint: e.target.value }))}
                rows={3} placeholder="Primary reason for visit..."
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-500/30 resize-none" />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Medical History</label>
                <textarea value={intakeForm.medical_history} onChange={e => setIntakeForm(f => ({ ...f, medical_history: e.target.value }))}
                  rows={2} placeholder="Past conditions, surgeries..."
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none resize-none" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Current Medications</label>
                <textarea value={intakeForm.medications} onChange={e => setIntakeForm(f => ({ ...f, medications: e.target.value }))}
                  rows={2} placeholder="Medication, dosage..."
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none resize-none" />
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Known Allergies</label>
              <input value={intakeForm.allergies} onChange={e => setIntakeForm(f => ({ ...f, allergies: e.target.value }))}
                placeholder="NKDA, Penicillin, Sulfa..." className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none" />
            </div>

            <label className="flex items-center gap-3 cursor-pointer">
              <input type="checkbox" checked={intakeForm.hipaa_consent} onChange={e => setIntakeForm(f => ({ ...f, hipaa_consent: e.target.checked }))}
                className="h-4 w-4 rounded border-border" />
              <div>
                <span className="text-sm font-medium">HIPAA Authorization Obtained</span>
                <p className="text-xs text-muted-foreground">Patient has signed HIPAA authorization form</p>
              </div>
            </label>

            <div className="flex gap-3 pt-2">
              <Button variant="outline" onClick={() => setShowIntakeForm(false)} className="flex-1">Cancel</Button>
              <Button onClick={handlePatientIntake} disabled={submittingIntake || !intakeForm.full_name || !intakeForm.chief_complaint} className="flex-1 bg-rose-600 hover:bg-rose-700 text-white">
                {submittingIntake ? <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Processing...</> : <><Sparkles className="h-4 w-4 mr-2" /> Submit Intake + Generate AI Summary</>}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
