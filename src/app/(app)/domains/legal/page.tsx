"use client";

import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type Tab = "cases" | "contract" | "research" | "billing";

interface BillingLog {
  id?: string;
  date?: string;
  description?: string;
  hours?: number | string;
  rate?: number | string;
}

interface LegalCase {
  id: string;
  case_name?: string;
  client_name?: string;
  case_type?: string;
  status?: string;
  billing_log?: string;
}

interface ContractAnalysis {
  error?: string;
  red_flags?: string[];
  risks?: string[];
  key_clauses?: string[];
  recommendations?: string[];
}

/** Safe numeric coercion: NaN / null / undefined -> 0 */
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Safe date formatting: invalid / missing -> "—" */
const fmtDate = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "\u2014";
  const d = new Date(v as string | number);
  return Number.isNaN(d.getTime()) ? "\u2014" : d.toLocaleDateString();
};

/** Parse a JSON array string; anything else -> [] */
const parseLogs = (raw: string | undefined): BillingLog[] => {
  try {
    const parsed: unknown = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? (parsed as BillingLog[]) : [];
  } catch {
    return [];
  }
};

export default function LegalDashboard() {
  const [activeTab, setActiveTab] = useState<Tab>("cases");
  const [cases, setCases] = useState<LegalCase[]>([]);
  const [loading, setLoading] = useState(false);

  // Cases state
  const [newCaseName, setNewCaseName] = useState("");
  const [newClientName, setNewClientName] = useState("");
  const [newCaseType, setNewCaseType] = useState("");

  // Contract Analyzer state
  const [contractText, setContractText] = useState("");
  const [focusAreas, setFocusAreas] = useState("");
  const [analysis, setAnalysis] = useState<ContractAnalysis | null>(null);
  const [analyzingContract, setAnalyzingContract] = useState(false);

  // Legal Research state
  const [searchQuery, setSearchQuery] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [researchResult, setResearchResult] = useState("");
  const [researching, setResearching] = useState(false);

  // Billing Logger state
  const [selectedCaseId, setSelectedCaseId] = useState("");
  const [billHours, setBillHours] = useState("");
  const [billRate, setBillRate] = useState("");
  const [billDesc, setBillDesc] = useState("");

  useEffect(() => {
    fetchCases();
  }, []);

  const fetchCases = async () => {
    try {
      const res = await fetch("/api/domains/legal?action=cases");
      if (res.ok) {
        const data = await res.json();
        setCases(data.cases || []);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleCreateCase = async () => {
    if (!newCaseName) return;
    setLoading(true);
    try {
      const res = await fetch("/api/domains/legal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create_case",
          case_name: newCaseName,
          client_name: newClientName,
          case_type: newCaseType
        })
      });
      if (res.ok) {
        setNewCaseName("");
        setNewClientName("");
        setNewCaseType("");
        fetchCases();
      }
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  };

  const handleAnalyzeContract = async () => {
    if (!contractText) return;
    setAnalyzingContract(true);
    try {
      const res = await fetch("/api/domains/legal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "analyze_contract",
          contract_text: contractText,
          focus_areas: focusAreas
        })
      });
      if (res.ok) {
        const data = await res.json();
        setAnalysis(data.analysis ?? null);
      }
    } catch (e) {
      console.error(e);
    }
    setAnalyzingContract(false);
  };

  const handleResearch = async () => {
    if (!searchQuery) return;
    setResearching(true);
    try {
      const res = await fetch("/api/domains/legal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "research_legal_topic",
          query: searchQuery,
          jurisdiction
        })
      });
      if (res.ok) {
        const data = await res.json();
        setResearchResult(data.research ?? "");
      }
    } catch (e) {
      console.error(e);
    }
    setResearching(false);
  };

  const handleLogBilling = async () => {
    if (!selectedCaseId || !billHours || !billRate) return;
    setLoading(true);
    try {
      const res = await fetch("/api/domains/legal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "log_billing",
          case_id: selectedCaseId,
          hours: billHours,
          rate: billRate,
          description: billDesc
        })
      });
      if (res.ok) {
        setBillHours("");
        setBillRate("");
        setBillDesc("");
        fetchCases();
      }
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  };

  const getStatusColor = (status: string) => {
    switch(status?.toLowerCase()) {
      case 'active': return 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-400';
      case 'closed': return 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-400';
      case 'won': return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400';
      case 'settled': return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400';
      default: return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-400';
    }
  };

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-8">
      <div className="flex items-center space-x-4">
        <h1 className="text-4xl font-bold text-slate-900 dark:text-white">⚖️ Legal Hub</h1>
        <p className="text-muted-foreground pt-2">Case Management & AI Legal Assistant</p>
      </div>

      <div className="flex space-x-2 border-b border-border mb-6 overflow-x-auto whitespace-nowrap">
        {[
          { id: "cases", label: "Case Files" },
          { id: "contract", label: "Contract Analyzer" },
          { id: "research", label: "Legal Research" },
          { id: "billing", label: "Billing Logger" }
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id as Tab)}
            className={cn(
              "px-4 py-2 font-medium text-sm transition-colors border-b-2",
              activeTab === t.id
                ? "border-indigo-500 text-indigo-600 dark:text-indigo-400"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {activeTab === "cases" && (
          <div className="space-y-6">
            <div className="rounded-xl border border-border bg-card p-5">
              <h2 className="text-xl font-semibold mb-4">Open New Case</h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                <input
                  type="text"
                  placeholder="Case Name"
                  className="w-full p-2 rounded border border-border bg-background"
                  value={newCaseName}
                  onChange={(e) => setNewCaseName(e.target.value)}
                />
                <input
                  type="text"
                  placeholder="Client Name"
                  className="w-full p-2 rounded border border-border bg-background"
                  value={newClientName}
                  onChange={(e) => setNewClientName(e.target.value)}
                />
                <input
                  type="text"
                  placeholder="Case Type (e.g., Corporate, Civil)"
                  className="w-full p-2 rounded border border-border bg-background"
                  value={newCaseType}
                  onChange={(e) => setNewCaseType(e.target.value)}
                />
              </div>
              <Button onClick={handleCreateCase} disabled={loading || !newCaseName}>
                {loading ? "Creating..." : "Create Case"}
              </Button>
            </div>

            <h2 className="text-2xl font-bold mt-8">Your Cases</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {cases.map((c) => (
                <div key={c.id} className="rounded-xl border border-border bg-card p-5">
                  <div className="flex justify-between items-start mb-2">
                    <h3 className="text-xl font-semibold">{c.case_name}</h3>
                    <span className={cn("text-xs px-2 py-1 rounded-full", getStatusColor(c.status ?? "active"))}>
                      {c.status || "active"}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground mb-1">Client: {c.client_name}</p>
                  <p className="text-sm text-muted-foreground mb-4">Type: {c.case_type}</p>
                  
                  <div className="border-t border-border pt-4 mt-4">
                    <h4 className="text-sm font-medium mb-2">Recent Billing</h4>
                    {(() => {
                      const logs = parseLogs(c.billing_log);
                      return logs.length > 0 ? (
                        <div className="space-y-2">
                          {logs.slice(-3).map((log, idx) => (
                            <div key={log.id ?? idx} className="text-xs flex justify-between">
                              <span className="text-muted-foreground">{fmtDate(log.date)} - {log.description}</span>
                              <span className="font-medium">{"$"}{num(log.hours) * num(log.rate)}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">No billing entries yet.</p>
                      );
                    })()}
                  </div>
                </div>
              ))}
              {cases.length === 0 && (
                <div className="col-span-full p-8 text-center text-muted-foreground border border-dashed rounded-xl border-border">
                  No cases found. Create one to get started.
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === "contract" && (
          <div className="space-y-6">
            <div className="rounded-xl border border-border bg-card p-5">
              <h2 className="text-xl font-semibold mb-4">AI Contract Analyzer</h2>
              <textarea
                className="w-full h-48 p-3 rounded border border-border bg-background mb-4 font-mono text-sm"
                placeholder="Paste contract text here..."
                value={contractText}
                onChange={(e) => setContractText(e.target.value)}
              />
              <input
                type="text"
                placeholder="Focus Areas (e.g., Liability, Termination)"
                className="w-full p-2 rounded border border-border bg-background mb-4"
                value={focusAreas}
                onChange={(e) => setFocusAreas(e.target.value)}
              />
              <Button onClick={handleAnalyzeContract} disabled={analyzingContract || !contractText}>
                {analyzingContract ? "Analyzing..." : "Analyze Contract"}
              </Button>
            </div>

            {analysis && !analysis.error && (
              <div className="space-y-4">
                <div className="rounded-xl border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-900/10 p-5">
                  <h3 className="text-lg font-semibold text-red-700 dark:text-red-400 mb-2">🚨 Red Flags</h3>
                  <ul className="list-disc pl-5 space-y-1 text-sm text-red-600 dark:text-red-300">
                    {analysis.red_flags?.map((flag: string, i: number) => <li key={i}>{flag}</li>)}
                  </ul>
                </div>
                
                <div className="rounded-xl border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-900/10 p-5">
                  <h3 className="text-lg font-semibold text-amber-700 dark:text-amber-400 mb-2">⚠️ Potential Risks</h3>
                  <ul className="list-disc pl-5 space-y-1 text-sm text-amber-600 dark:text-amber-300">
                    {analysis.risks?.map((risk: string, i: number) => <li key={i}>{risk}</li>)}
                  </ul>
                </div>
                
                <div className="rounded-xl border border-green-200 dark:border-green-900/50 bg-green-50 dark:bg-green-900/10 p-5">
                  <h3 className="text-lg font-semibold text-green-700 dark:text-green-400 mb-2">✅ Key Clauses</h3>
                  <ul className="list-disc pl-5 space-y-1 text-sm text-green-600 dark:text-green-300">
                    {analysis.key_clauses?.map((clause: string, i: number) => <li key={i}>{clause}</li>)}
                  </ul>
                </div>

                <div className="rounded-xl border border-blue-200 dark:border-blue-900/50 bg-blue-50 dark:bg-blue-900/10 p-5">
                  <h3 className="text-lg font-semibold text-blue-700 dark:text-blue-400 mb-2">💡 Recommendations</h3>
                  <ul className="list-disc pl-5 space-y-1 text-sm text-blue-600 dark:text-blue-300">
                    {analysis.recommendations?.map((rec: string, i: number) => <li key={i}>{rec}</li>)}
                  </ul>
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === "research" && (
          <div className="space-y-6">
            <div className="rounded-xl border border-border bg-card p-5">
              <h2 className="text-xl font-semibold mb-4">Legal Research Assistant</h2>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
                <input
                  type="text"
                  placeholder="Jurisdiction (e.g., California, Federal)"
                  className="w-full p-2 rounded border border-border bg-background col-span-1"
                  value={jurisdiction}
                  onChange={(e) => setJurisdiction(e.target.value)}
                />
                <input
                  type="text"
                  placeholder="Research query... e.g., 'What are the requirements for piercing the corporate veil?'"
                  className="w-full p-2 rounded border border-border bg-background col-span-1 md:col-span-3"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleResearch()}
                />
              </div>
              <Button onClick={handleResearch} disabled={researching || !searchQuery}>
                {researching ? "Researching..." : "Search"}
              </Button>
            </div>

            {researchResult && (
              <div className="rounded-xl border border-border bg-card p-5">
                <div className="mb-4 p-3 bg-yellow-50 dark:bg-yellow-900/20 text-yellow-800 dark:text-yellow-200 text-xs rounded border border-yellow-200 dark:border-yellow-900/50">
                  <strong>Disclaimer:</strong> This is an AI-generated research summary and does not constitute formal legal advice. Always verify with primary sources and a qualified attorney.
                </div>
                <div className="prose dark:prose-invert max-w-none text-sm whitespace-pre-wrap">
                  {researchResult}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === "billing" && (
          <div className="space-y-6">
            <div className="rounded-xl border border-border bg-card p-5">
              <h2 className="text-xl font-semibold mb-4">Log Billable Hours</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <select
                  className="w-full p-2 rounded border border-border bg-background"
                  value={selectedCaseId}
                  onChange={(e) => setSelectedCaseId(e.target.value)}
                >
                  <option value="">Select Case...</option>
                  {cases.map(c => (
                    <option key={c.id} value={c.id}>{c.case_name}</option>
                  ))}
                </select>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="number"
                    placeholder="Hours"
                    className="w-full p-2 rounded border border-border bg-background"
                    value={billHours}
                    onChange={(e) => setBillHours(e.target.value)}
                  />
                  <input
                    type="number"
                    placeholder="Rate ($)"
                    className="w-full p-2 rounded border border-border bg-background"
                    value={billRate}
                    onChange={(e) => setBillRate(e.target.value)}
                  />
                </div>
              </div>
              <input
                type="text"
                placeholder="Description of work..."
                className="w-full p-2 rounded border border-border bg-background mb-4"
                value={billDesc}
                onChange={(e) => setBillDesc(e.target.value)}
              />
              <Button onClick={handleLogBilling} disabled={loading || !selectedCaseId || !billHours || !billRate}>
                {loading ? "Logging..." : "Log Time"}
              </Button>
            </div>

            {selectedCaseId && (
              <div className="rounded-xl border border-border bg-card p-5">
                <h3 className="text-lg font-semibold mb-4">Billing Summary for Case</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-left">
                    <thead className="text-xs text-muted-foreground uppercase bg-muted/50">
                      <tr>
                        <th className="px-4 py-3">Date</th>
                        <th className="px-4 py-3">Description</th>
                        <th className="px-4 py-3 text-right">Hours</th>
                        <th className="px-4 py-3 text-right">Rate</th>
                        <th className="px-4 py-3 text-right">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(() => {
                        const selectedCase = cases.find(c => c.id === selectedCaseId);
                        if (!selectedCase) return null;
                        const logs = parseLogs(selectedCase.billing_log);

                        let totalAmount = 0;
                        let totalHours = 0;

                        return (
                          <>
                            {logs.map((log, idx) => {
                              const hours = num(log.hours);
                              const rate = num(log.rate);
                              totalAmount += hours * rate;
                              totalHours += hours;
                              return (
                                <tr key={log.id ?? idx} className="border-b border-border">
                                  <td className="px-4 py-3">{fmtDate(log.date)}</td>
                                  <td className="px-4 py-3">{log.description}</td>
                                  <td className="px-4 py-3 text-right">{hours}</td>
                                  <td className="px-4 py-3 text-right">{"$"}{rate}</td>
                                  <td className="px-4 py-3 text-right font-medium">{"$"}{(hours * rate).toFixed(2)}</td>
                                </tr>
                              );
                            })}
                            {logs.length > 0 ? (
                              <tr className="font-bold bg-muted/20">
                                <td colSpan={2} className="px-4 py-3 text-right">Total</td>
                                <td className="px-4 py-3 text-right">{totalHours.toFixed(1)}</td>
                                <td className="px-4 py-3 text-right"></td>
                                <td className="px-4 py-3 text-right">{"$"}{totalAmount.toFixed(2)}</td>
                              </tr>
                            ) : (
                              <tr>
                                <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">No entries found</td>
                              </tr>
                            )}
                          </>
                        );
                      })()}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
